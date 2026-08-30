"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { safeRedirectPath } from "@/lib/redirect";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Sign in failed (${response.status})`);
        return;
      }

      // `next` is validated so a crafted link cannot bounce us off-site.
      const destination = safeRedirectPath(searchParams.get("next"));
      router.replace(destination);
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <button type="submit" disabled={pending || password === ""}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
