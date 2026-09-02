"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  IMPORTABLE_EXTENSIONS,
  isImportableName,
  type ImportedItem,
} from "@/lib/import-documents";

/**
 * Drag a file or a folder in; it becomes a draft.
 *
 * Files are read in the browser and their text posted as JSON, rather than
 * uploaded as multipart. A folder of essays is a few hundred kilobytes of
 * text, and this way there is no file-size ceiling to explain, no temporary
 * storage, and the "which of these am I actually importing?" question can be
 * answered on screen before anything is sent.
 */

/** Enough for any personal archive, and a bound on what one drop can do. */
const MAX_FILES = 200;
/** Matches the cap the API enforces; progress is reported between batches. */
const BATCH_SIZE = 10;

type Candidate = { path: string; file: File };

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "ready"; candidates: Candidate[]; ignored: string[] }
  | { kind: "importing"; done: number; total: number }
  | { kind: "done"; items: ImportedItem[] };

export function DropImport() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/import")
      .then((r) => r.json() as Promise<{ imported_posts: number }>)
      .then((body) => {
        if (!cancelled) setImportedCount(body.imported_posts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const accept = useCallback((found: Candidate[]) => {
    const ignored = found
      .filter((c) => !isImportableName(c.path))
      .map((c) => c.path);
    const candidates = found
      .filter((c) => isImportableName(c.path))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, MAX_FILES);

    if (candidates.length === 0) {
      setPhase({ kind: "idle" });
      setError(
        ignored.length > 0
          ? `Nothing importable there. Looked for ${IMPORTABLE_EXTENSIONS.join(", ")} files.`
          : "That folder appears to be empty.",
      );
      return;
    }
    setError(null);
    setPhase({ kind: "ready", candidates, ignored });
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      setError(null);
      setPhase({ kind: "reading" });

      try {
        accept(await collectFromDrop(event.dataTransfer));
      } catch (cause) {
        setPhase({ kind: "idle" });
        setError(cause instanceof Error ? cause.message : "Could not read that");
      }
    },
    [accept],
  );

  const runImport = useCallback(async () => {
    if (phase.kind !== "ready") return;
    // Captured before the phase changes, so a failure can restore this exact
    // selection rather than reconstructing it from a later state.
    const { candidates, ignored } = phase;

    setError(null);
    setPhase({ kind: "importing", done: 0, total: candidates.length });
    const items: ImportedItem[] = [];

    try {
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const documents = await Promise.all(
          batch.map(async (c) => ({ path: c.path, content: await c.file.text() })),
        );

        const response = await fetch("/api/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ documents }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Import failed (${response.status})`);
        }

        const body = (await response.json()) as { items: ImportedItem[] };
        items.push(...body.items);
        setPhase({
          kind: "importing",
          done: Math.min(i + BATCH_SIZE, candidates.length),
          total: candidates.length,
        });
      }

      setPhase({ kind: "done", items });
      void fetch("/api/import")
        .then((r) => r.json() as Promise<{ imported_posts: number }>)
        .then((b) => setImportedCount(b.imported_posts))
        .catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed");
      // Whatever landed before the failure is still worth showing.
      setPhase(
        items.length > 0
          ? { kind: "done", items }
          : { kind: "ready", candidates, ignored },
      );
    }
  }, [phase]);

  return (
    <div className="drop-import">
      <div
        className={dragging ? "dropzone is-dragging" : "dropzone"}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          // Only when the pointer leaves the zone itself, not a child.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => void onDrop(e)}
      >
        <p className="dropzone-lead">Drag files or folders here</p>
        <p className="hint">
          {IMPORTABLE_EXTENSIONS.join(", ")} · subfolders are read too · up to{" "}
          {MAX_FILES} files
        </p>
        <div className="row dropzone-actions">
          <button
            type="button"
            className="btn btn--small"
            onClick={() => fileInput.current?.click()}
          >
            Choose files
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => folderInput.current?.click()}
          >
            Choose a folder
          </button>
        </div>

        <input
          ref={fileInput}
          type="file"
          multiple
          accept={IMPORTABLE_EXTENSIONS.join(",")}
          hidden
          onChange={(e) => {
            accept(fromFileList(e.target.files));
            e.target.value = "";
          }}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          // Not a React prop; set through the DOM in an effect below.
          onChange={(e) => {
            accept(fromFileList(e.target.files));
            e.target.value = "";
          }}
        />
        <DirectoryAttribute inputRef={folderInput} />
      </div>

      {importedCount !== null && importedCount > 0 && (
        <p className="hint">
          {importedCount} post{importedCount === 1 ? "" : "s"} on this blog came
          from an import.
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {phase.kind === "reading" && <p className="hint">Reading…</p>}

      {phase.kind === "ready" && (
        <Preview
          candidates={phase.candidates}
          ignored={phase.ignored}
          onCancel={() => setPhase({ kind: "idle" })}
          onConfirm={() => void runImport()}
        />
      )}

      {phase.kind === "importing" && (
        <p className="hint" role="status">
          Importing {phase.done} of {phase.total}…
        </p>
      )}

      {phase.kind === "done" && <Report items={phase.items} />}
    </div>
  );
}

/**
 * `webkitdirectory` turns a file input into a folder picker.
 *
 * Set through the DOM because React does not recognise it as a prop and
 * writing it in JSX produces a console warning on every render.
 */
function DirectoryAttribute({
  inputRef,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  useEffect(() => {
    inputRef.current?.setAttribute("webkitdirectory", "");
  }, [inputRef]);
  return null;
}

function Preview({
  candidates,
  ignored,
  onCancel,
  onConfirm,
}: {
  candidates: Candidate[];
  ignored: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="import-preview">
      <div className="import-preview-head">
        <h2 className="label">
          {candidates.length} document{candidates.length === 1 ? "" : "s"} ready
        </h2>
        <div className="row">
          <button type="button" className="btn btn--quiet btn--small" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary btn--small" onClick={onConfirm}>
            Import as drafts
          </button>
        </div>
      </div>

      <ul className="import-list">
        {candidates.map((c) => (
          <li key={c.path}>
            <span className="import-list-path">{c.path}</span>
            <span className="meta">{formatBytes(c.file.size)}</span>
          </li>
        ))}
      </ul>

      {ignored.length > 0 && (
        <p className="hint">
          {ignored.length} other file{ignored.length === 1 ? "" : "s"} ignored —
          only {IMPORTABLE_EXTENSIONS.join(", ")} can be read.
        </p>
      )}
    </div>
  );
}

const OUTCOME_LABELS: Record<ImportedItem["outcome"], string> = {
  created: "New draft",
  updated: "Draft updated",
  "skipped-published": "Left alone (published)",
  failed: "Failed",
};

function Report({ items }: { items: ImportedItem[] }) {
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.outcome] = (acc[item.outcome] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="import-report">
      <h2 className="label">Result</h2>
      <p className="meta">
        {[
          counts.created && `${counts.created} new`,
          counts.updated && `${counts.updated} updated`,
          counts["skipped-published"] && `${counts["skipped-published"]} left alone`,
          counts.failed && `${counts.failed} failed`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <div className="table-scroll">
        <table className="story-table">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Result</th>
              <th scope="col">Draft</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.path}>
                <td>{item.path}</td>
                <td>
                  <span className={`import-outcome import-outcome--${item.outcome}`}>
                    {OUTCOME_LABELS[item.outcome]}
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
    </div>
  );
}

/* --- reading what was dropped --------------------------------------------- */

/**
 * Everything under what was dropped, folders included.
 *
 * The entries have to be taken out of the DataTransfer synchronously: it is
 * emptied as soon as the drop handler yields, so awaiting first leaves nothing
 * to read.
 */
async function collectFromDrop(transfer: DataTransfer): Promise<Candidate[]> {
  const entries = Array.from(transfer.items)
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);

  // Older browsers give no entry API; a flat file list is still usable.
  if (entries.length === 0) return fromFileList(transfer.files);

  const found: Candidate[] = [];
  for (const entry of entries) await walk(entry, "", found);
  return found;
}

async function walk(
  entry: FileSystemEntry,
  prefix: string,
  found: Candidate[],
): Promise<void> {
  if (found.length >= MAX_FILES) return;

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    found.push({ path: `${prefix}${entry.name}`, file });
    return;
  }

  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();

  /*
    readEntries returns at most 100 children per call and signals the end with
    an empty batch. Calling it once — the obvious implementation — silently
    truncates any folder with more than a hundred items in it.
  */
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, found);
  }
}

/** A plain `<input type="file">` selection, keeping folder paths where present. */
function fromFileList(files: FileList | null): Candidate[] {
  return Array.from(files ?? []).map((file) => ({
    // webkitRelativePath is set for a directory pick, empty for loose files.
    path: file.webkitRelativePath || file.name,
    file,
  }));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
