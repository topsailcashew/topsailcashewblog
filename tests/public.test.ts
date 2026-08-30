import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { GET as rssFeed } from "@/app/rss.xml/route";
import { posts } from "@/db/schema";
import {
  POSTS_PER_PAGE,
  getFeed,
  getPublishedPost,
  getTagName,
  listPublishedSlugs,
  listPublishedTagSlugs,
  readingMinutes,
} from "@/lib/public-posts";
import { affectsPublicOutput } from "@/lib/revalidate";
import { syncPostTags } from "@/lib/tags";
import {
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

async function seedPost(options: {
  title: string;
  slug: string;
  status?: "draft" | "published";
  publishedAt?: Date;
  html?: string;
  tags?: string[];
  excerpt?: string;
}) {
  const [row] = await db()
    .insert(posts)
    .values({
      title: options.title,
      slug: options.slug,
      excerpt: options.excerpt ?? null,
      contentHtml: options.html ?? "<p>Body.</p>",
      status: options.status ?? "published",
      publishedAt: options.status === "draft" ? null : (options.publishedAt ?? new Date()),
    })
    .returning();
  if (options.tags?.length) await syncPostTags(db(), row.id, options.tags);
  return row;
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

describe(
  "public reading layer",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    describe("drafts are invisible", () => {
      it("keeps drafts out of the feed", async () => {
        await seedPost({ title: "Live", slug: "live", publishedAt: day(2) });
        await seedPost({ title: "Hidden", slug: "hidden", status: "draft" });

        const feed = await getFeed(db(), 1);
        assert.deepEqual(feed.posts.map((p) => p.slug), ["live"]);
        assert.equal(feed.totalPosts, 1);
      });

      it("returns null for a draft requested by slug", async () => {
        await seedPost({ title: "Hidden", slug: "hidden", status: "draft" });
        assert.equal(await getPublishedPost(db(), "hidden"), null);
      });

      it("returns null for a slug that does not exist", async () => {
        assert.equal(await getPublishedPost(db(), "nope"), null);
      });

      it("omits drafts from the pre-render list", async () => {
        await seedPost({ title: "Live", slug: "live" });
        await seedPost({ title: "Hidden", slug: "hidden", status: "draft" });
        assert.deepEqual(await listPublishedSlugs(db()), ["live"]);
      });

      it("omits a tag carried only by drafts", async () => {
        await seedPost({ title: "Live", slug: "live", tags: ["Shown"] });
        await seedPost({
          title: "Hidden",
          slug: "hidden",
          status: "draft",
          tags: ["Concealed"],
        });

        assert.deepEqual(await listPublishedTagSlugs(db()), ["shown"]);
        assert.equal(await getTagName(db(), "concealed"), null);
        assert.equal(await getTagName(db(), "shown"), "Shown");
      });

      it("keeps a draft out of a tag feed it shares with a published post", async () => {
        await seedPost({ title: "Live", slug: "live", tags: ["Shared"] });
        await seedPost({
          title: "Hidden",
          slug: "hidden",
          status: "draft",
          tags: ["Shared"],
        });

        const feed = await getFeed(db(), 1, "shared");
        assert.deepEqual(feed.posts.map((p) => p.slug), ["live"]);
        assert.equal(feed.totalPosts, 1);
      });
    });

    describe("ordering and pagination", () => {
      it("sorts newest first by published_at", async () => {
        await seedPost({ title: "Oldest", slug: "a", publishedAt: day(1) });
        await seedPost({ title: "Newest", slug: "c", publishedAt: day(9) });
        await seedPost({ title: "Middle", slug: "b", publishedAt: day(5) });

        const feed = await getFeed(db(), 1);
        assert.deepEqual(feed.posts.map((p) => p.slug), ["c", "b", "a"]);
      });

      it("splits into pages of POSTS_PER_PAGE without gaps or repeats", async () => {
        const total = POSTS_PER_PAGE + 3;
        for (let i = 1; i <= total; i += 1) {
          await seedPost({ title: `Post ${i}`, slug: `post-${i}`, publishedAt: day(i) });
        }

        const first = await getFeed(db(), 1);
        const second = await getFeed(db(), 2);

        assert.equal(first.posts.length, POSTS_PER_PAGE);
        assert.equal(second.posts.length, 3);
        assert.equal(first.totalPages, 2);
        assert.equal(first.totalPosts, total);

        const seen = [...first.posts, ...second.posts].map((p) => p.slug);
        assert.equal(new Set(seen).size, total, "pages overlapped or dropped a post");
      });

      it("returns an empty page past the end rather than wrapping", async () => {
        await seedPost({ title: "Only", slug: "only" });
        assert.deepEqual((await getFeed(db(), 99)).posts, []);
      });

      it("treats a nonsense page number as page 1", async () => {
        await seedPost({ title: "Only", slug: "only" });
        assert.equal((await getFeed(db(), 0)).page, 1);
        assert.equal((await getFeed(db(), Number.NaN)).page, 1);
      });
    });

    describe("rss", () => {
      it("is well-formed and lists only published posts", async () => {
        await seedPost({
          title: "Live & <well> \"quoted\"",
          slug: "live",
          excerpt: "An excerpt",
          tags: ["Craft"],
          publishedAt: day(3),
          html: "<p>Body with <strong>markup</strong>.</p>",
        });
        await seedPost({ title: "Hidden", slug: "hidden", status: "draft" });

        const xml = await (await rssFeed()).text();

        assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
        assert.match(xml, /<rss version="2\.0"/);
        assert.ok(!xml.includes("Hidden"), "a draft reached the feed");
        // The title's special characters must be escaped, not raw.
        assert.ok(xml.includes("Live &amp; &lt;well&gt;"));
        assert.match(xml, /<guid isPermaLink="true">[^<]*\/live<\/guid>/);
        assert.match(xml, /<category>Craft<\/category>/);
        assert.match(xml, /<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/);
        assert.ok(xml.includes("<![CDATA["), "content was not wrapped for the reader");
      });

      it("rewrites site-relative image URLs to absolute ones", async () => {
        const previous = process.env.NEXT_PUBLIC_SITE_URL;
        process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
        try {
          await seedPost({
            title: "With image",
            slug: "with-image",
            html: '<p><img src="/media/2026/08/a.png" alt="x"><a href="/other">link</a></p>',
          });

          const xml = await (await rssFeed()).text();
          const inside = xml.slice(xml.indexOf("<![CDATA["));

          assert.ok(
            inside.includes('src="https://example.test/media/2026/08/a.png"'),
            "image was not made absolute",
          );
          assert.ok(
            inside.includes('href="https://example.test/other"'),
            "link was not made absolute",
          );
          assert.match(xml, /<link>https:\/\/example\.test\/with-image<\/link>/);
        } finally {
          if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
          else process.env.NEXT_PUBLIC_SITE_URL = previous;
        }
      });

      it("serves the right content type", async () => {
        await seedPost({ title: "Live", slug: "live" });
        const response = await rssFeed();
        assert.match(
          response.headers.get("content-type") ?? "",
          /application\/rss\+xml/,
        );
      });
    });
  },
);

describe("when a write touches the public cache", () => {
  it("invalidates for anything involving a published post", () => {
    // Publishing, editing a live post, and unpublishing all change the site.
    assert.equal(affectsPublicOutput("published", "draft"), true);
    assert.equal(affectsPublicOutput("published", "published"), true);
    assert.equal(affectsPublicOutput("draft", "published"), true);
    assert.equal(affectsPublicOutput("published"), true);
  });

  it("leaves the cache alone while a draft is being written", () => {
    // The editor autosaves every ten seconds; none of that is public.
    assert.equal(affectsPublicOutput("draft", "draft"), false);
    assert.equal(affectsPublicOutput("draft"), false);
  });
});

describe("reading time", () => {
  it("counts words, not markup", () => {
    const words = Array.from({ length: 400 }, () => "word").join(" ");
    assert.equal(readingMinutes(`<p class="x">${words}</p>`), 2);
  });

  it("ignores script and style content", () => {
    const noisy = `<style>${"a ".repeat(500)}</style><p>one two three</p>`;
    assert.equal(readingMinutes(noisy), 1);
  });

  it("never reports less than a minute", () => {
    assert.equal(readingMinutes("<p>Short.</p>"), 1);
    assert.equal(readingMinutes(null), 1);
    assert.equal(readingMinutes(""), 1);
  });
});
