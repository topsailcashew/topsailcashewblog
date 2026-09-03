"use client";

import { useCallback, useId, useRef, useState } from "react";
import { HONEYPOT_FIELD } from "@/lib/validation";

/**
 * The signup form.
 *
 * Attribution is read here rather than on the server because there is nowhere
 * else it exists: UTM parameters live in the URL the browser is looking at,
 * and `document.referrer` is not sent as a header on a same-origin fetch. It
 * is collected once, at submit, and never afterwards — this sets no cookie,
 * loads no third-party script and follows nobody around the site.
 */

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

export function SubscribeForm({ pitch }: { pitch: string }) {
  const fieldId = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "done"; message: string } | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Never read back into React state: a controlled honeypot would be visible
  // in the DOM as a value, which is exactly what the field is trying to hide.
  const honeypot = useRef<HTMLInputElement>(null);

  const submit = useCallback(async () => {
    setState({ kind: "busy" });
    try {
      const params = new URLSearchParams(window.location.search);
      const attribution: Record<string, string> = {};
      for (const key of UTM_KEYS) {
        const value = params.get(key);
        if (value) attribution[key] = value;
      }

      const response = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          ...attribution,
          // Same-origin referrers say nothing about acquisition; the server
          // reduces whatever arrives to an origin anyway.
          referrer:
            document.referrer && !document.referrer.startsWith(window.location.origin)
              ? document.referrer
              : null,
          landing_path: window.location.pathname,
          [HONEYPOT_FIELD]: honeypot.current?.value ?? "",
        }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Something went wrong");

      setState({ kind: "done", message: body.message ?? "Check your inbox to confirm." });
      setEmail("");
    } catch (cause) {
      setState({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Something went wrong",
      });
    }
  }, [email]);

  if (state.kind === "done") {
    return (
      <aside className="subscribe subscribe--done">
        <p className="subscribe-done">{state.message}</p>
      </aside>
    );
  }

  return (
    <aside className="subscribe" aria-labelledby={`${fieldId}-heading`}>
      <h2 className="subscribe-heading" id={`${fieldId}-heading`}>
        Get new writing by email
      </h2>
      <p className="subscribe-pitch">{pitch}</p>

      <form
        className="subscribe-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="visually-hidden" htmlFor={`${fieldId}-email`}>
          Email address
        </label>
        <input
          id={`${fieldId}-email`}
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        {/*
          A field a person never sees and never fills. Hidden with CSS rather
          than `hidden`, because a bot reading the DOM ignores styles and an
          `[hidden]` input is the first thing they learn to skip.
        */}
        <div className="honeypot" aria-hidden="true">
          <label htmlFor={`${fieldId}-website`}>Website</label>
          <input
            ref={honeypot}
            id={`${fieldId}-website`}
            name={HONEYPOT_FIELD}
            type="text"
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        <button type="submit" className="btn btn--primary" disabled={state.kind === "busy"}>
          {state.kind === "busy" ? "…" : "Subscribe"}
        </button>
      </form>

      <p className="subscribe-note">
        One click to confirm, one to leave. No tracking beyond whether the email
        was opened, and nothing is ever shared.
      </p>

      {state.kind === "error" && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
    </aside>
  );
}
