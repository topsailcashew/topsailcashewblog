"use client";

import { useCallback, useEffect, useState } from "react";
import type { SerializedRedirect } from "@/lib/redirects";

async function fetchRedirects(): Promise<SerializedRedirect[]> {
  const response = await fetch("/api/redirects");
  if (!response.ok) throw new Error(`Could not load (${response.status})`);
  const body = (await response.json()) as { redirects: SerializedRedirect[] };
  return body.redirects;
}

/** Add, review and remove redirect rules. */
export function RedirectManager() {
  const [rows, setRows] = useState<SerializedRedirect[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setRows(await fetchRedirects());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load redirects");
    } finally {
      setBusy(false);
    }
  }, []);

  // The first load fetches before touching state, so the effect body itself
  // does not set state — and a response arriving after unmount is discarded.
  useEffect(() => {
    let cancelled = false;
    void fetchRedirects()
      .then((redirects) => {
        if (!cancelled) setRows(redirects);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load redirects");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const add = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/redirects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from_path: from, to_path: to }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not add (${response.status})`);
      }
      setFrom("");
      setTo("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the redirect");
    } finally {
      setBusy(false);
    }
  }, [from, load, to]);

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      await fetch(`/api/redirects/${id}`, { method: "DELETE" });
      await load();
    },
    [load],
  );

  const automatic = rows.filter((row) => row.automatic).length;

  return (
    <div className="redirect-manager">
      <form
        className="redirect-form"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label>
          From
          <input
            value={from}
            placeholder="/old-url"
            onChange={(event) => setFrom(event.target.value)}
            required
          />
        </label>
        <label>
          To
          <input
            value={to}
            placeholder="/new-url or https://elsewhere.example"
            onChange={(event) => setTo(event.target.value)}
            required
          />
        </label>
        <button type="submit" className="btn btn--primary btn--small" disabled={busy}>
          Add
        </button>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <p className="hint">
        {rows.length === 0
          ? "No redirects yet. One is recorded automatically whenever you change a slug."
          : `${rows.length} rule${rows.length === 1 ? "" : "s"}${
              automatic > 0 ? `, ${automatic} recorded automatically from slug changes` : ""
            }.`}
      </p>

      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="story-table">
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Source</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code>{row.from_path}</code>
                  </td>
                  <td>
                    <code>{row.to_path}</code>
                  </td>
                  {/* `.meta` is display:flex — on a <td> that drops the cell
                      out of the table layout, so it goes on a span inside. */}
                  <td>
                    <span className="meta">
                      {row.automatic ? "slug change" : "manual"}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--small btn--danger"
                      disabled={busy}
                      onClick={() => void remove(row.id)}
                      aria-label={`Remove redirect from ${row.from_path}`}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
