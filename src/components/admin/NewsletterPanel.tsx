"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { PublishMode } from "@/lib/validation";
import { EditorSection } from "./EditorSection";

type Status = {
  performance: {
    campaign_id: string;
    delivered: number;
    open_rate: number | null;
    ctor: number | null;
  } | null;
  audience: number;
  enabled: boolean;
  smtp_ready: boolean;
};

type Progress = { sent: number; failed: number; remaining: number };

/**
 * What a publish does about email.
 *
 * The three modes are one decision, so they are one control rather than a
 * checkbox next to the Publish button. "Publish and email" is the common case
 * and leads; "email only" is deliberately last, because it is the one that
 * cannot be undone — you can unpublish a post, but you cannot unsend it.
 */
export function NewsletterPanel({
  postId,
  status,
  onPublished,
}: {
  postId: string | null;
  status: string;
  onPublished: () => void;
}) {
  const [state, setState] = useState<Status | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!postId) return;
    try {
      const response = await fetch(`/api/posts/${postId}/newsletter`);
      if (!response.ok) return;
      setState((await response.json()) as Status);
    } catch {
      // The panel is informational; a failed poll should not raise an error
      // over a post the writer is in the middle of.
    }
  }, [postId]);

  /**
   * Runs the send to completion.
   *
   * The server mails one batch per request — a Worker cannot hold hundreds of
   * outbound SMTP connections open — so the loop lives here. Progress is
   * recorded server-side in `email_sends`, so closing this tab stops the loop
   * without losing the send: pressing the button again resumes it.
   */
  const run = useCallback(
    async (mode: PublishMode) => {
      if (!postId) return;
      setBusy(true);
      setError(null);
      setErrors([]);
      setProgress(null);

      let sent = 0;
      let failed = 0;
      const collected: string[] = [];

      try {
        for (let pass = 0; pass < 500; pass += 1) {
          const response = await fetch(`/api/posts/${postId}/newsletter`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            // Only the first pass changes the post's status; the rest just
            // keep mailing, so a resumed send cannot re-stamp published_at.
            body: JSON.stringify({ mode: pass === 0 ? mode : "email" }),
          });

          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
            sent?: number;
            failed?: number;
            remaining?: number;
            errors?: string[];
          };
          if (!response.ok) throw new Error(body.error ?? `Send failed (${response.status})`);

          sent += body.sent ?? 0;
          failed += body.failed ?? 0;
          for (const message of body.errors ?? []) {
            if (collected.length < 10) collected.push(message);
          }
          setProgress({ sent, failed, remaining: body.remaining ?? 0 });

          if (mode === "publish") break;
          if ((body.remaining ?? 0) === 0) break;
        }
        setErrors(collected);
        onPublished();
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Send failed");
      } finally {
        setBusy(false);
      }
    },
    [load, onPublished, postId],
  );

  const alreadySent = state?.performance != null;
  /*
    Null until the section is expanded. Distinguished from "off" on purpose:
    treating an unloaded panel as disabled would flash "the newsletter is
    switched off" at a writer whose newsletter is running perfectly well.
  */
  const blocked =
    state === null
      ? null
      : !state.enabled
        ? "The newsletter is switched off."
        : !state.smtp_ready
          ? "No mail server configured."
          : state.audience === 0
            ? "Nobody has confirmed a subscription yet."
            : null;

  return (
    <EditorSection
      title="Newsletter"
      summary={summaryFor(state, status)}
      // Loaded on expand rather than on mount, like the history panel: most
      // edits never touch this section, and it costs four queries to answer.
      onOpen={() => {
        if (state === null) void load();
      }}
    >
      <div className="newsletter-panel">
        {!postId && (
          <p className="hint">Save the post before sending it to anyone.</p>
        )}

        {alreadySent && state?.performance && (
          <p className="newsletter-sent">
            Emailed to {state.performance.delivered}.{" "}
            {percent(state.performance.open_rate)} opened,{" "}
            {percent(state.performance.ctor)} of those clicked.
          </p>
        )}

        {state === null ? (
          <p className="hint">Checking the list…</p>
        ) : blocked ? (
          <p className="hint">
            {blocked} <Link href="/admin/settings">Settings →</Link>
          </p>
        ) : (
          <p className="hint">
            {state.audience} confirmed subscriber{state.audience === 1 ? "" : "s"}.
            {alreadySent && " Sending again only reaches people who joined since."}
          </p>
        )}

        <div className="newsletter-actions">
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={busy || !postId || Boolean(blocked)}
            onClick={() => void run("publish_and_email")}
          >
            {busy ? "Sending…" : "Publish and email"}
          </button>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy || !postId || status === "published"}
            onClick={() => void run("publish")}
          >
            Publish only
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--small"
            disabled={busy || !postId || Boolean(blocked)}
            onClick={() => {
              if (
                window.confirm(
                  "Send to the list without publishing? The email carries the whole piece, and it cannot be unsent.",
                )
              ) {
                void run("email");
              }
            }}
          >
            Email only
          </button>
        </div>

        {progress && (
          <p className="newsletter-progress" role="status">
            {progress.sent} sent
            {progress.failed > 0 && `, ${progress.failed} failed`}
            {progress.remaining > 0 ? `, ${progress.remaining} to go…` : "."}
          </p>
        )}

        {errors.length > 0 && (
          <ul className="newsletter-errors">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </EditorSection>
  );
}

/**
 * The collapsed header.
 *
 * Before the section is opened nothing has been fetched, so this can only say
 * what the editor already knows. Once opened, "emailed" is the fact worth
 * carrying on a closed header — it is the one state in here that cannot be
 * undone.
 */
function summaryFor(state: Status | null, status: string): string | undefined {
  if (state?.performance) return `emailed ${state.performance.delivered}`;
  if (state && !state.enabled) return "off";
  return status === "published" ? undefined : "not published";
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
