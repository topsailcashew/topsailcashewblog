import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { emailSends } from "@/db/schema";
import {
  loadSmtpSettings,
  redactSmtp,
  resolveSmtpPassword,
  saveSmtpSettings,
} from "@/lib/email/config";
import { personalizeHtml, renderPostEmail } from "@/lib/email/render";
import {
  createClickToken,
  createUnsubscribeToken,
  readClickToken,
  readUnsubscribeToken,
} from "@/lib/email/tokens";
import {
  buildClickTokens,
  getCampaignMetrics,
  getOrCreateCampaignForPost,
  getPostEmailPerformance,
  getRollingAverage,
  loadEmailPost,
  recordClick,
  recordOpen,
  sendCampaignBatch,
  type Mailer,
} from "@/lib/newsletter";
import { createPost } from "@/lib/posts";
import { decryptSecret, encryptSecret } from "@/lib/settings";
import {
  confirmSubscriber,
  getAcquisitionSources,
  getGrowthSeries,
  getSubscriberMetrics,
  getSubscriberTimeline,
  listConfirmedRecipients,
  subscribe,
  unsubscribeSubscriber,
} from "@/lib/subscribers";
import {
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

const SECRET = "test-newsletter-secret";

/** Collects what would have been sent, instead of opening a socket. */
function recordingMailer() {
  const sent: { to: string; subject: string; html: string; text: string; headers: Record<string, string> }[] = [];
  const mailer: Mailer = async (message) => {
    sent.push({
      to: message.to.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers ?? {},
    });
  };
  return { mailer, sent };
}

function failingMailer(failFor: string): Mailer {
  return async (message) => {
    if (message.to.email === failFor) throw new Error("550 mailbox unavailable");
  };
}

describe("signed email links", () => {
  it("carries the destination inside the token rather than a query parameter", async () => {
    const token = await createClickToken("send-1", "https://example.com/post", SECRET);
    const payload = await readClickToken(token, SECRET);
    assert.deepEqual(payload, { d: "send-1", u: "https://example.com/post" });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createClickToken("send-1", "https://evil.example", SECRET);
    assert.equal(await readClickToken(token, "another-secret"), null);
  });

  it("rejects a token whose payload was edited", async () => {
    const token = await createClickToken("send-1", "https://example.com", SECRET);
    const [body, signature] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ v: 1, p: { d: "send-1", u: "https://evil.example" } }),
    )
      .toString("base64url")
      .replace(/=+$/, "");
    assert.equal(await readClickToken(`${tampered}.${signature}`, SECRET), null);
    assert.ok(body.length > 0);
  });

  it("will not replay an unsubscribe token as a click token", async () => {
    // Both are HMACs over the same secret; only the purpose prefix separates
    // them. Without it, one bearer token would be interchangeable with another.
    const token = await createUnsubscribeToken("subscriber-1", SECRET);
    assert.equal(await readClickToken(token, SECRET), null);
    assert.equal(await readUnsubscribeToken(token, SECRET), "subscriber-1");
  });
});

describe("email rendering", () => {
  const post = {
    title: "On slow software",
    slug: "on-slow-software",
    excerpt: "A note",
    content_html:
      '<p>Read <a href="https://example.com/other">this</a> as well.</p><h2>Later</h2>',
    cover_image_url: null,
    published_at: "2026-08-01T00:00:00.000Z",
  };

  it("inlines styles onto the tags the editor can produce", () => {
    const { html } = renderPostEmail(post, { footer: "Footer" });
    assert.match(html, /<p style="margin:0 0 20px;font:400 17px/);
    assert.match(html, /<h2 style="margin:32px 0 12px/);
    assert.ok(!/<p>/.test(html), "an unstyled paragraph survived");
  });

  it("drops the site link for an email-only send", () => {
    const withLink = renderPostEmail(post, { footer: "F" });
    const without = renderPostEmail(post, { footer: "F", siteLink: false });
    assert.match(withLink.html, /Read it on the site/);
    assert.ok(!/Read it on the site/.test(without.html));
    assert.ok(!/Read it on the site/.test(without.text));
  });

  it("produces a plain-text alternative with the markup gone", () => {
    const { text } = renderPostEmail(post, { footer: "Footer line" });
    assert.ok(!text.includes("<"), "tags leaked into the text part");
    assert.match(text, /On slow software/);
    assert.match(text, /Footer line/);
  });

  it("rewrites body links for tracking but never the unsubscribe link", async () => {
    const { html } = renderPostEmail(post, { footer: "F" });
    const links = await buildClickTokens(html, "send-1", SECRET);

    const personalized = personalizeHtml(html, {
      unsubscribeUrl: "https://blog.example/e/u?t=abc",
      pixelUrl: "https://blog.example/e/o/xyz",
      trackLink: (url) => links.get(url) ?? url,
    });

    assert.match(personalized, /href="[^"]*\/e\/c\//, "no link was wrapped");
    assert.ok(
      !/e\/c\/[^"]*e%2Fu/.test(personalized),
      "the unsubscribe link was routed through the tracker",
    );
    assert.match(personalized, /href="https:\/\/blog\.example\/e\/u\?t=abc"/);
    assert.match(personalized, /<img src="https:\/\/blog\.example\/e\/o\/xyz"/);
  });
});

describe("SMTP settings", () => {
  it("round-trips a password through AES-GCM", async () => {
    const cipher = await encryptSecret("hunter2", SECRET);
    assert.ok(!cipher.includes("hunter2"));
    assert.equal(await decryptSecret(cipher, SECRET), "hunter2");
  });

  it("returns null rather than throwing for a value it cannot decrypt", async () => {
    const cipher = await encryptSecret("hunter2", SECRET);
    assert.equal(await decryptSecret(cipher, "rotated-secret"), null);
    assert.equal(await decryptSecret("not-a-token", SECRET), null);
    assert.equal(await decryptSecret(null, SECRET), null);
  });
});

describe(
  "audience",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("lands a signup as pending and does not mail it yet", async () => {
      const { subscriber, created } = await subscribe(db(), {
        email: "  Reader@Example.COM ",
        name: "Reader",
      });
      assert.equal(created, true);
      assert.equal(subscriber.email, "reader@example.com");
      assert.equal(subscriber.status, "pending");
      assert.deepEqual(await listConfirmedRecipients(db()), []);
    });

    it("is idempotent — a second signup is not a second row", async () => {
      await subscribe(db(), { email: "a@example.com" });
      const again = await subscribe(db(), { email: "A@example.com" });
      assert.equal(again.created, false);
    });

    it("brings an unsubscribed address back, clearing the old confirmation", async () => {
      const { subscriber } = await subscribe(db(), { email: "a@example.com" });
      await confirmSubscriber(db(), subscriber.id);
      await unsubscribeSubscriber(db(), subscriber.id);

      const again = await subscribe(db(), { email: "a@example.com" });
      assert.equal(again.resubscribed, true);
      assert.equal(again.subscriber.status, "pending");
      assert.equal(again.subscriber.confirmedAt, null);
    });

    it("leaves a bounced address on the suppression list", async () => {
      const { subscriber } = await subscribe(db(), { email: "gone@example.com" });
      await db()
        .update((await import("@/db/schema")).subscribers)
        .set({ status: "bounced" })
        .where(eq((await import("@/db/schema")).subscribers.id, subscriber.id));

      const again = await subscribe(db(), { email: "gone@example.com" });
      assert.equal(again.subscriber.status, "bounced");
      assert.equal(again.resubscribed, false);
    });

    it("keeps the first-touch attribution when someone signs up twice", async () => {
      await subscribe(db(), {
        email: "a@example.com",
        utm_source: "newsletter-swap",
        landing_path: "/on-slow-software",
      });
      await subscribe(db(), { email: "a@example.com", utm_source: "twitter" });

      const [source] = await getAcquisitionSources(db());
      assert.equal(source.label, "newsletter-swap");
      assert.equal(source.count, 1);
    });

    it("labels an untagged signup by referrer, then falls back to direct", async () => {
      await subscribe(db(), { email: "a@example.com", referrer_host: "news.ycombinator.com" });
      await subscribe(db(), { email: "b@example.com" });

      const labels = (await getAcquisitionSources(db())).map((row) => row.label).sort();
      assert.deepEqual(labels, ["direct", "news.ycombinator.com"]);
    });

    it("returns a full 30-day spine, zeros included", async () => {
      await subscribe(db(), { email: "a@example.com" });
      const series = await getGrowthSeries(db(), 30);

      assert.equal(series.length, 30, "a day with no activity was dropped");
      assert.equal(series[series.length - 1].joined, 1);
      assert.ok(series.every((point) => point.net === point.joined - point.left));
    });

    it("counts an unsubscribe as churn on the day it happened", async () => {
      const { subscriber } = await subscribe(db(), { email: "a@example.com" });
      await unsubscribeSubscriber(db(), subscriber.id);

      const series = await getGrowthSeries(db(), 30);
      const today = series[series.length - 1];
      assert.equal(today.joined, 1);
      assert.equal(today.left, 1);
      assert.equal(today.net, 0);
    });

    it("writes a timeline entry for every lifecycle step", async () => {
      const { subscriber } = await subscribe(db(), { email: "a@example.com" });
      await confirmSubscriber(db(), subscriber.id);
      await unsubscribeSubscriber(db(), subscriber.id);

      const timeline = await getSubscriberTimeline(db(), subscriber.id);
      assert.deepEqual(
        timeline.map((entry) => entry.type),
        ["unsubscribed", "confirmed", "subscribed"],
      );
    });
  },
);

describe(
  "sending a campaign",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    async function seed(count: number) {
      const post = await createPost(db(), {
        title: "On slow software",
        content_html: '<p>Hello. <a href="https://example.com/x">Link</a></p>',
        status: "published",
      });
      const emailPost = await loadEmailPost(db(), post.id);
      assert.ok(emailPost);

      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const { subscriber } = await subscribe(db(), { email: `r${i}@example.com` });
        await confirmSubscriber(db(), subscriber.id);
        ids.push(subscriber.id);
      }
      const campaign = await getOrCreateCampaignForPost(db(), emailPost, "Footer");
      return { post, campaign, ids };
    }

    it("mails only confirmed subscribers", async () => {
      const { campaign } = await seed(2);
      // A third who never confirmed.
      await subscribe(db(), { email: "pending@example.com" });

      const { mailer, sent } = recordingMailer();
      const result = await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });

      assert.equal(result.sent, 2);
      assert.equal(result.remaining, 0);
      assert.deepEqual(
        sent.map((message) => message.to).sort(),
        ["r0@example.com", "r1@example.com"],
      );
    });

    it("resumes where it stopped instead of starting over", async () => {
      const { campaign } = await seed(5);
      const { mailer, sent } = recordingMailer();

      const first = await sendCampaignBatch(db(), campaign.id, mailer, {
        secret: SECRET,
        batchSize: 2,
      });
      assert.equal(first.sent, 2);
      assert.equal(first.remaining, 3);

      const second = await sendCampaignBatch(db(), campaign.id, mailer, {
        secret: SECRET,
        batchSize: 10,
      });
      assert.equal(second.sent, 3);
      assert.equal(second.remaining, 0);

      assert.equal(new Set(sent.map((message) => message.to)).size, 5, "somebody was mailed twice");
    });

    it("does not re-mail anyone when the send is run again", async () => {
      const { campaign } = await seed(3);
      const { mailer, sent } = recordingMailer();

      await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });
      const again = await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });

      assert.equal(again.sent, 0);
      assert.equal(sent.length, 3);
    });

    it("records a per-recipient failure without losing the rest of the batch", async () => {
      const { campaign } = await seed(3);

      const result = await sendCampaignBatch(
        db(),
        campaign.id,
        failingMailer("r1@example.com"),
        { secret: SECRET },
      );

      assert.equal(result.sent, 2);
      assert.equal(result.failed, 1);
      assert.match(result.errors[0], /r1@example\.com: 550/);

      const rows = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.campaignId, campaign.id));
      assert.equal(rows.filter((row) => row.status === "failed").length, 1);
      assert.equal(rows.filter((row) => row.status === "sent").length, 2);
    });

    it("gives every message a working one-click unsubscribe header", async () => {
      const { campaign } = await seed(1);
      const { mailer, sent } = recordingMailer();
      await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });

      const headers = sent[0].headers;
      assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

      const url = headers["List-Unsubscribe"].match(/<([^>,]+)>/)?.[1];
      assert.ok(url, "no unsubscribe URL in the header");
      const token = new URL(url, "https://blog.example").searchParams.get("t");
      assert.ok(await readUnsubscribeToken(token, SECRET), "the header token does not verify");
    });

    it("counts a first open once and later opens only in the total", async () => {
      const { campaign } = await seed(1);
      const { mailer } = recordingMailer();
      await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });

      const [send] = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.campaignId, campaign.id));

      await recordOpen(db(), send.id);
      const [afterFirst] = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.id, send.id));
      const firstOpenAt = afterFirst.openedAt;

      await recordOpen(db(), send.id);
      const [afterSecond] = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.id, send.id));

      assert.equal(afterSecond.openCount, 2);
      assert.deepEqual(afterSecond.openedAt, firstOpenAt, "opened_at moved on a re-open");
    });

    it("treats a click as an open, so CTOR can never exceed 100%", async () => {
      const { campaign } = await seed(1);
      const { mailer } = recordingMailer();
      await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });

      const [send] = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.campaignId, campaign.id));

      // No open recorded first: the pixel was blocked, as it usually is.
      await recordClick(db(), send.id, "https://example.com/x");

      const [metrics] = await getCampaignMetrics(db());
      assert.equal(metrics.opened, 1);
      assert.equal(metrics.clicked, 1);
      assert.equal(metrics.ctor, 1);
      assert.ok((metrics.ctor ?? 0) <= 1);
    });

    it("computes open rate and CTOR from the send rows", async () => {
      const { campaign } = await seed(4);
      const { mailer } = recordingMailer();
      await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });

      const sends = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.campaignId, campaign.id));

      await recordOpen(db(), sends[0].id);
      await recordOpen(db(), sends[1].id);
      await recordClick(db(), sends[0].id, "https://example.com/x");

      const [metrics] = await getCampaignMetrics(db());
      assert.equal(metrics.delivered, 4);
      assert.equal(metrics.open_rate, 0.5);
      assert.equal(metrics.ctor, 0.5);
    });

    it("reports per-subscriber lifetime rates", async () => {
      const { campaign, ids } = await seed(1);
      const { mailer } = recordingMailer();
      await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });

      const [send] = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.campaignId, campaign.id));
      await recordOpen(db(), send.id);

      const metrics = await getSubscriberMetrics(db(), ids[0]);
      assert.equal(metrics.delivered, 1);
      assert.equal(metrics.opened, 1);
      assert.equal(metrics.open_rate, 1);
      assert.equal(metrics.ctor, 0);
    });

    it("attaches the campaign subject to engagement entries in the timeline", async () => {
      const { campaign, ids } = await seed(1);
      const { mailer } = recordingMailer();
      await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });

      const [send] = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.campaignId, campaign.id));
      await recordOpen(db(), send.id);

      const timeline = await getSubscriberTimeline(db(), ids[0]);
      const opened = timeline.find((entry) => entry.type === "opened");
      assert.equal(opened?.campaign?.subject, "On slow software");
    });

    it("maps a post to its campaign's performance", async () => {
      const { campaign, post } = await seed(2);
      const { mailer } = recordingMailer();
      await sendCampaignBatch(db(), campaign.id, mailer, { secret: SECRET });

      const performance = await getPostEmailPerformance(db(), [post.id]);
      assert.equal(performance.get(post.id)?.delivered, 2);
      assert.equal(performance.get(post.id)?.open_rate, 0);
    });

    it("averages the last N campaigns rather than pooling every send", async () => {
      // Two campaigns, wildly different sizes. Pooled, the big one would decide
      // the baseline; averaged per campaign, both count equally.
      const big = await seed(4);
      const { mailer } = recordingMailer();
      await sendCampaignBatch(db(), big.campaign.id, mailer, { secret: SECRET });
      const bigSends = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.campaignId, big.campaign.id));
      await recordOpen(db(), bigSends[0].id); // 25%

      const second = await createPost(db(), {
        title: "A second piece",
        content_html: "<p>Words</p>",
        status: "published",
      });
      const secondPost = await loadEmailPost(db(), second.id);
      assert.ok(secondPost);
      const smallCampaign = await getOrCreateCampaignForPost(db(), secondPost, "Footer");
      await sendCampaignBatch(db(), smallCampaign.id, mailer, { secret: SECRET });
      const smallSends = await db()
        .select()
        .from(emailSends)
        .where(eq(emailSends.campaignId, smallCampaign.id));
      for (const send of smallSends) await recordOpen(db(), send.id); // 100%

      const rolling = await getRollingAverage(db(), 10);
      assert.equal(rolling.campaigns, 2);
      // (0.25 + 1.0) / 2, not 5/8.
      assert.ok(
        Math.abs((rolling.open_rate ?? 0) - 0.625) < 1e-9,
        `expected 0.625, got ${rolling.open_rate}`,
      );
    });

    it("reuses one campaign per post rather than making a second", async () => {
      const { campaign, post } = await seed(1);
      const emailPost = await loadEmailPost(db(), post.id);
      assert.ok(emailPost);
      const again = await getOrCreateCampaignForPost(db(), emailPost, "Footer");
      assert.equal(again.id, campaign.id);
    });

    it("snapshots the body, so editing the post does not rewrite what was sent", async () => {
      const { campaign, post } = await seed(1);
      const { updatePost } = await import("@/lib/posts");
      await updatePost(db(), post.id, { content_html: "<p>Completely different</p>" });

      const emailPost = await loadEmailPost(db(), post.id);
      assert.ok(emailPost);
      const again = await getOrCreateCampaignForPost(db(), emailPost, "Footer");
      assert.match(again.bodyHtml ?? "", /Hello\./);
      assert.ok(!/Completely different/.test(again.bodyHtml ?? ""));
      assert.equal(again.id, campaign.id);
    });
  },
);

describe(
  "settings storage",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("stores the password encrypted and never returns it", async () => {
      await saveSmtpSettings(
        db(),
        {
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          username: "user",
          password: "hunter2",
          fromName: "Blog",
          fromEmail: "hello@example.com",
        },
        SECRET,
      );

      const stored = await loadSmtpSettings(db());
      assert.ok(stored.passwordCipher);
      assert.ok(!stored.passwordCipher.includes("hunter2"));
      assert.equal(await resolveSmtpPassword(stored, SECRET), "hunter2");

      const redacted = redactSmtp(stored);
      assert.equal(redacted.has_password, true);
      assert.ok(!("passwordCipher" in redacted));
      assert.ok(!JSON.stringify(redacted).includes("hunter2"));
    });

    it("keeps the stored password when the form posts a blank field", async () => {
      await saveSmtpSettings(
        db(),
        { host: "a", port: 587, security: "starttls", username: "u", password: "keepme", fromName: "B", fromEmail: "a@b.com" },
        SECRET,
      );
      await saveSmtpSettings(db(), { host: "b", password: "" }, SECRET);

      const stored = await loadSmtpSettings(db());
      assert.equal(stored.host, "b");
      assert.equal(await resolveSmtpPassword(stored, SECRET), "keepme");
    });

    it("clears the password only when explicitly told to", async () => {
      await saveSmtpSettings(
        db(),
        { host: "a", port: 587, security: "starttls", username: "u", password: "gone", fromName: "B", fromEmail: "a@b.com" },
        SECRET,
      );
      await saveSmtpSettings(db(), { password: null }, SECRET);

      const stored = await loadSmtpSettings(db());
      assert.equal(stored.passwordCipher, null);
      assert.equal(await resolveSmtpPassword(stored, SECRET), null);
    });

    it("lets the environment override a stored host", async () => {
      await saveSmtpSettings(
        db(),
        { host: "stored.example.com", port: 587, security: "starttls", username: "u", fromName: "B", fromEmail: "a@b.com" },
        SECRET,
      );

      process.env.SMTP_HOST = "env.example.com";
      try {
        assert.equal((await loadSmtpSettings(db())).host, "env.example.com");
      } finally {
        delete process.env.SMTP_HOST;
      }
    });
  },
);
