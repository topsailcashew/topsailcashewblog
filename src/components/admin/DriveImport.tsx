"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ImportReport } from "@/lib/drive-import";
import type { DriveSetupStatus } from "@/lib/drive-config";

type Setup = {
  status: DriveSetupStatus;
  client_email: string | null;
  folder_id: string | null;
  imported_posts: number;
};

const OUTCOME_LABELS: Record<string, string> = {
  created: "New draft",
  updated: "Draft updated",
  unchanged: "No change",
  "skipped-published": "Left alone (published)",
  failed: "Failed",
};

export function DriveImport() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/drive")
      .then((r) => r.json() as Promise<Setup>)
      .then((body) => {
        if (!cancelled) setSetup(body);
      })
      .catch(() => {
        if (!cancelled) setError("Could not read the Drive settings");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const response = await fetch("/api/drive/import", { method: "POST" });
      const body = (await response.json()) as { report?: ImportReport; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Import failed (${response.status})`);
      setReport(body.report ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }, []);

  if (!setup) return <p className="hint">Checking the connection…</p>;

  if (setup.status !== "ready") {
    return <NotConnected setup={setup} />;
  }

  return (
    <div className="drive-import">
      <div className="drive-status">
        <p className="hint">
          Connected as <code>{setup.client_email}</code>, reading folder{" "}
          <code>{setup.folder_id}</code>.
          {setup.imported_posts > 0 &&
            ` ${setup.imported_posts} post${setup.imported_posts === 1 ? "" : "s"} came from Drive.`}
        </p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void run()}
          disabled={busy}
        >
          {busy ? "Importing…" : "Import from Drive"}
        </button>
      </div>

      <p className="hint">
        Everything arrives as a draft. Published posts are never overwritten,
        and a draft is only replaced when the Drive copy is newer than the last
        import — so anything you have changed here is safe unless you edit the
        document in Drive afterwards.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {report && <Report report={report} />}
    </div>
  );
}

function NotConnected({ setup }: { setup: Setup }) {
  return (
    <div className="drive-setup">
      <p className="hint">
        {setup.status === "missing-credentials"
          ? "Google Drive is not connected yet."
          : "Almost there — the credentials are set, but no folder has been chosen."}
      </p>

      <ol className="drive-steps">
        <li>
          In the Google Cloud console, create a project, enable the{" "}
          <strong>Google Drive API</strong>, and create a{" "}
          <strong>service account</strong>. Add a JSON key to it and download it.
        </li>
        <li>
          Put the key into the Worker, without pasting it anywhere else:
          <pre>
            <code>
              npx wrangler secret put GOOGLE_CLIENT_EMAIL{"\n"}
              npx wrangler secret put GOOGLE_PRIVATE_KEY
            </code>
          </pre>
          They are the <code>client_email</code> and <code>private_key</code>{" "}
          fields of the JSON file.
        </li>
        <li>
          In Google Drive, <strong>share the folder</strong> with that{" "}
          <code>client_email</code> address, as a Viewer.
          {setup.client_email && (
            <>
              {" "}
              For this deployment that is <code>{setup.client_email}</code>.
            </>
          )}
        </li>
        <li>
          Open the folder in Drive and copy the last part of its URL — that is
          the folder id:
          <pre>
            <code>npx wrangler secret put GOOGLE_DRIVE_FOLDER_ID</code>
          </pre>
        </li>
      </ol>

      <p className="hint">
        The full walkthrough is in{" "}
        <Link href="https://github.com/topsailcashew/topsailcashewblog/blob/main/docs/ARCHITECTURE.md">
          the architecture notes
        </Link>
        .
      </p>
    </div>
  );
}

function Report({ report }: { report: ImportReport }) {
  const { counts } = report;
  return (
    <div className="drive-report">
      <h2 className="label">Result</h2>
      <p className="meta">
        {counts.created} new · {counts.updated} updated · {counts.unchanged} unchanged
        {counts["skipped-published"] > 0 && ` · ${counts["skipped-published"]} left alone`}
        {counts.failed > 0 && ` · ${counts.failed} failed`}
      </p>

      {report.truncated && (
        <p className="hint hint--warn">
          The folder holds more documents than one run imports. Run it again to
          continue.
        </p>
      )}

      {report.items.length > 0 && (
        <div className="table-scroll">
          <table className="story-table">
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Folder</th>
                <th scope="col">Result</th>
                <th scope="col">Post</th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((item) => (
                <tr key={`${item.folder}/${item.file}`}>
                  <td>{item.file}</td>
                  <td>
                    <span className="meta">{item.folder}</span>
                  </td>
                  <td>
                    <span className={`drive-outcome drive-outcome--${item.outcome}`}>
                      {OUTCOME_LABELS[item.outcome] ?? item.outcome}
                    </span>
                    {item.detail && <span className="meta">{item.detail}</span>}
                  </td>
                  <td>
                    {item.postId ? (
                      <Link href={`/admin/posts/${item.postId}`}>
                        {item.title ?? "Open"}
                      </Link>
                    ) : (
                      <span className="meta">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.skipped.length > 0 && (
        <>
          <h2 className="label">Passed over</h2>
          <ul className="drive-skipped">
            {report.skipped.map((entry) => (
              <li key={entry.name}>
                {entry.name} <span className="meta">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
