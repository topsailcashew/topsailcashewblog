"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { NewsletterSettings, RedactedSmtp } from "@/lib/email/config";
import type { RedactedAi } from "@/lib/ai/config";

export type FediverseView = {
  enabled: boolean;
  username: string;
  summary: string;
  /** Derived server-side from the username and the site's host. */
  handle: string;
  has_key: boolean;
  followers: number;
};

/**
 * Newsletter and mail-server settings.
 *
 * One form, saved as a whole, rather than per-field autosave. Sending
 * configuration is not like writing a post: a half-applied change is a broken
 * mail server, and you want to press Save deliberately and then test.
 */
export function SettingsForm({
  initialSmtp,
  initialNewsletter,
  initialFediverse,
  initialAi,
}: {
  initialSmtp: RedactedSmtp;
  initialNewsletter: NewsletterSettings;
  initialFediverse: FediverseView;
  initialAi: RedactedAi;
}) {
  const router = useRouter();

  const [smtp, setSmtp] = useState(initialSmtp);
  const [newsletter, setNewsletter] = useState(initialNewsletter);
  const [fediverse, setFediverse] = useState(initialFediverse);
  const [ai, setAi] = useState(initialAi);
  /* Held apart from `ai` for the same reason the SMTP password is. */
  const [apiKey, setApiKey] = useState("");
  const [aiTest, setAiTest] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "ok"; ms: number; unsaved: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  /**
   * Held apart from `smtp` on purpose. The stored password never reaches this
   * component, so an empty box has to mean "unchanged" — if it lived on the
   * same object the first save of any other field would clear the credential.
   */
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  /*
    Derived from the live form state, not from what was loaded — the warning
    should clear the moment a host is typed, not after the next save.
  */
  const smtpReady = smtp.host.trim() !== "" && smtp.fromEmail.trim() !== "" && smtp.port > 0;

  const [testTo, setTestTo] = useState("");
  const [testState, setTestState] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "ok"; to: string } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const save = useCallback(async () => {
    setState("saving");
    setError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newsletter: {
            enabled: newsletter.enabled,
            pitch: newsletter.pitch,
            footer: newsletter.footer,
            double_opt_in: newsletter.doubleOptIn,
          },
          fediverse: {
            enabled: fediverse.enabled,
            username: fediverse.username,
            summary: fediverse.summary,
          },
          ai: {
            enabled: ai.enabled,
            text_model: ai.textModel,
            image_model: ai.imageModel,
            ...(apiKey === "" ? {} : { api_key: apiKey }),
          },
          smtp: {
            host: smtp.host,
            port: smtp.port,
            security: smtp.security,
            username: smtp.username,
            from_name: smtp.fromName,
            from_email: smtp.fromEmail,
            reply_to: smtp.replyTo ?? "",
            // Omitted when untouched, so the stored one survives.
            ...(password === "" ? {} : { password }),
          },
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          details?: Record<string, string[]>;
        };
        const detail = body.details
          ? Object.entries(body.details)
              .map(([field, messages]) => `${field}: ${messages.join(", ")}`)
              .join("; ")
          : null;
        throw new Error(detail ?? body.error ?? `Save failed (${response.status})`);
      }

      const saved = (await response.json()) as {
        smtp: RedactedSmtp;
        newsletter: NewsletterSettings;
        fediverse: FediverseView;
        ai: RedactedAi;
      };
      setSmtp(saved.smtp);
      setNewsletter(saved.newsletter);
      setFediverse(saved.fediverse);
      setAi(saved.ai);
      setPassword("");
      setApiKey("");
      setState("saved");
      router.refresh();
    } catch (cause) {
      setState("idle");
      setError(cause instanceof Error ? cause.message : "Could not save");
    }
  }, [ai, apiKey, fediverse, newsletter, password, router, smtp]);

  const testAi = useCallback(async () => {
    setAiTest({ kind: "busy" });
    try {
      // The ids as typed, not as stored. Testing a model you cannot see is
      // how this reported a failure about an id that was no longer on screen.
      const response = await fetch("/api/settings/ai/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text_model: ai.textModel,
          image_model: ai.imageModel,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        latency_ms?: number;
        unsaved?: boolean;
      };
      if (!response.ok) throw new Error(body.error ?? `Test failed (${response.status})`);
      setAiTest({ kind: "ok", ms: body.latency_ms ?? 0, unsaved: Boolean(body.unsaved) });
    } catch (cause) {
      setAiTest({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Test failed",
      });
    }
  }, [ai.imageModel, ai.textModel]);

  const sendTest = useCallback(async () => {
    setTestState({ kind: "busy" });
    try {
      const response = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: testTo }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Test failed (${response.status})`);
      setTestState({ kind: "ok", to: testTo });
    } catch (cause) {
      setTestState({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Test failed",
      });
    }
  }, [testTo]);

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <section className="panel">
        <h2 className="label">Newsletter</h2>

        <label className="check-row">
          <input
            type="checkbox"
            checked={newsletter.enabled}
            onChange={(event) =>
              setNewsletter({ ...newsletter, enabled: event.target.checked })
            }
          />
          Accept signups and allow sending
        </label>
        <p className="hint">
          Off, the signup form does not render on the site and the editor
          refuses to send. Nothing already collected is touched.
        </p>

        {newsletter.enabled && !smtpReady && (
          <p className="hint hint--warn" role="alert">
            Signups are open but no mail server is configured below. Readers
            will subscribe, see &ldquo;check your inbox&rdquo;, and never get a
            confirmation — with double opt-in on, every one of them stays
            <em> pending</em> and can never be sent to. Add SMTP settings, or
            turn signups off until you have.
          </p>
        )}

        <label>
          Pitch
          <textarea
            rows={2}
            value={newsletter.pitch}
            onChange={(event) => setNewsletter({ ...newsletter, pitch: event.target.value })}
          />
        </label>
        <p className="hint">One line above the signup form. Say what arrives and how often.</p>

        <label>
          Email footer
          <textarea
            rows={2}
            value={newsletter.footer}
            onChange={(event) => setNewsletter({ ...newsletter, footer: event.target.value })}
          />
        </label>
        <p className="hint">
          Printed above the unsubscribe link in every email. Saying where the
          address came from is the thing that stops a reader reporting spam
          because they forgot signing up.
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={newsletter.doubleOptIn}
            onChange={(event) =>
              setNewsletter({ ...newsletter, doubleOptIn: event.target.checked })
            }
          />
          Require a confirmation click
        </label>
        <p className="hint">
          Leave this on. A self-hosted sending domain has no reputation to
          spend, and one complaint from an address somebody else typed in is
          expensive in a way it is not for a large provider.
        </p>
      </section>

      <section className="panel">
        <h2 className="label">Mail server (SMTP)</h2>
        <p className="hint">
          Any provider that speaks SMTP submission: Amazon SES, Postmark,
          SendGrid, Fastmail, your own server. Port 25 is blocked on
          Cloudflare&rsquo;s network — use 587 with STARTTLS, or 465 with TLS.
        </p>

        <div className="field-row">
          <label className="field-grow">
            Host
            <input
              value={smtp.host}
              placeholder="smtp.example.com"
              onChange={(event) => setSmtp({ ...smtp, host: event.target.value })}
            />
          </label>
          <label className="field-narrow">
            Port
            <input
              type="number"
              value={smtp.port}
              onChange={(event) => setSmtp({ ...smtp, port: Number(event.target.value) })}
            />
          </label>
          <label className="field-narrow">
            Security
            <select
              value={smtp.security}
              onChange={(event) =>
                setSmtp({ ...smtp, security: event.target.value as RedactedSmtp["security"] })
              }
            >
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">None</option>
            </select>
          </label>
        </div>

        <div className="field-row">
          <label className="field-grow">
            Username
            <input
              value={smtp.username}
              autoComplete="off"
              onChange={(event) => setSmtp({ ...smtp, username: event.target.value })}
            />
          </label>
          <label className="field-grow">
            Password
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              placeholder={
                smtp.password_from_env
                  ? "Supplied by SMTP_PASSWORD"
                  : smtp.has_password
                    ? "Stored — leave blank to keep"
                    : "Not set"
              }
              disabled={smtp.password_from_env}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </div>
        <p className="hint">
          {smtp.password_from_env ? (
            <>
              The environment supplies this, which takes precedence over
              anything stored here — and is the safer place for it.
            </>
          ) : (
            <>
              Stored encrypted, and never sent back to this page. A Worker
              secret is safer still:{" "}
              <code>npx wrangler secret put SMTP_PASSWORD</code> overrides
              whatever is saved here.
            </>
          )}
        </p>

        <div className="field-row">
          <label className="field-grow">
            From name
            <input
              value={smtp.fromName}
              onChange={(event) => setSmtp({ ...smtp, fromName: event.target.value })}
            />
          </label>
          <label className="field-grow">
            From address
            <input
              type="email"
              value={smtp.fromEmail}
              placeholder="hello@example.com"
              onChange={(event) => setSmtp({ ...smtp, fromEmail: event.target.value })}
            />
          </label>
        </div>

        <label>
          Reply-to (optional)
          <input
            type="email"
            value={smtp.replyTo ?? ""}
            onChange={(event) => setSmtp({ ...smtp, replyTo: event.target.value || null })}
          />
        </label>
      </section>

      <section className="panel">
        <h2 className="label">Fediverse</h2>
        <p className="hint">
          Publishes each new post to Mastodon and anything else that speaks
          ActivityPub, and routes replies into the comment queue alongside the
          ones typed into the site. Nothing is followed back — this account
          publishes, it does not read timelines.
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={fediverse.enabled}
            onChange={(event) =>
              setFediverse({ ...fediverse, enabled: event.target.checked })
            }
          />
          Publish to the fediverse
        </label>

        <div className="field-row">
          <label className="field-grow">
            Handle
            <input
              value={fediverse.username}
              onChange={(event) =>
                setFediverse({ ...fediverse, username: event.target.value })
              }
            />
          </label>
        </div>
        <p className="hint">
          People will find you as <code>{fediverse.handle}</code>.{" "}
          {fediverse.has_key ? (
            <>
              {fediverse.followers} follower{fediverse.followers === 1 ? "" : "s"}.
              Changing the handle after anyone has followed breaks their
              lookup — the identity is the key, but the handle is how it is
              found.
            </>
          ) : (
            <>
              A signing key is generated the first time a remote server asks
              for the profile.
            </>
          )}
        </p>

        <label>
          Profile summary
          <textarea
            rows={2}
            value={fediverse.summary}
            onChange={(event) => setFediverse({ ...fediverse, summary: event.target.value })}
          />
        </label>
      </section>

      <section className="panel">
        <h2 className="label">Writing assistant (Gemini)</h2>
        <p className="hint">
          Adds a structural read, cover-image generation and metadata
          suggestions to the editor. The readability numbers in the Writing
          panel need none of this — they are measured locally and work without
          a key.
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={ai.enabled}
            onChange={(event) => setAi({ ...ai, enabled: event.target.checked })}
          />
          Enable AI assistance
        </label>
        <p className="hint">
          Nothing runs on its own. Every button in the editor is one API call —
          a fully assisted post costs a few pence, most of it the cover image.
        </p>

        <label>
          API key
          <input
            type="password"
            value={apiKey}
            autoComplete="new-password"
            placeholder={
              ai.key_from_env
                ? "Supplied by GEMINI_API_KEY"
                : ai.has_key
                  ? "Stored — leave blank to keep"
                  : "Not set"
            }
            disabled={ai.key_from_env}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <p className="hint">
          {ai.key_from_env ? (
            <>
              The environment supplies this, which takes precedence over
              anything stored here — and is the safer place for it.
            </>
          ) : (
            <>
              Stored encrypted, and never sent back to this page. A Worker
              secret is safer still:{" "}
              <code>npx wrangler secret put GEMINI_API_KEY</code> overrides
              whatever is saved here.
            </>
          )}
        </p>

        <div className="field-row">
          <label className="field-grow">
            Text model
            <input
              value={ai.textModel}
              placeholder="gemini-3.8-flash"
              onChange={(event) => setAi({ ...ai, textModel: event.target.value })}
            />
          </label>
          <label className="field-grow">
            Image model
            <input
              value={ai.imageModel}
              placeholder="gemini-3.1-flash-image"
              onChange={(event) => setAi({ ...ai, imageModel: event.target.value })}
            />
          </label>
        </div>
        <p className="hint">
          Model ids move. If a call comes back saying no such model, change it
          here rather than waiting for a deploy.
        </p>

        <div className="field-row">
          <button
            type="button"
            className="btn"
            disabled={aiTest.kind === "busy" || !ai.has_key}
            onClick={() => void testAi()}
          >
            {aiTest.kind === "busy" ? "Testing…" : "Test connection"}
          </button>
          {aiTest.kind === "ok" && (
            <span className="muted">
              {ai.textModel} answered in {aiTest.ms} ms.
              {aiTest.unsaved ? " Save to start using it." : ""}
            </span>
          )}
        </div>
        {aiTest.kind === "error" && (
          <p className="error" role="alert">
            {aiTest.message}
          </p>
        )}
      </section>

      <div className="row settings-actions">
        <button type="submit" className="btn btn--primary" disabled={state === "saving"}>
          {state === "saving" ? "Saving…" : "Save settings"}
        </button>
        {state === "saved" && <span className="muted">Saved.</span>}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="panel">
        <h2 className="label">Send a test</h2>
        <p className="hint">
          Save first, then send one message to yourself. Finding out a password
          is wrong halfway through mailing the list cannot be undone; finding
          out from one test costs nothing.
        </p>
        <div className="field-row">
          <label className="field-grow">
            Test address
            <input
              type="email"
              value={testTo}
              placeholder="you@example.com"
              onChange={(event) => setTestTo(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => void sendTest()}
            disabled={testState.kind === "busy" || testTo === ""}
          >
            {testState.kind === "busy" ? "Sending…" : "Send test"}
          </button>
        </div>
        {testState.kind === "ok" && (
          <p className="muted">Accepted by {smtp.host} for delivery to {testState.to}.</p>
        )}
        {testState.kind === "error" && (
          <p className="error" role="alert">
            {testState.message}
          </p>
        )}
      </section>
    </form>
  );
}
