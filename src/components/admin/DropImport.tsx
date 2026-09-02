"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ImportedItem } from "@/lib/import-documents";
import {
  ACCEPTED_DESCRIPTION,
  prepareFile,
  type Prepared,
} from "@/lib/prepare-documents";

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

type Ready = Extract<Prepared, { kind: "ready" }>;
type Blocked = Extract<Prepared, { kind: "blocked" }>;
type Ignored = Extract<Prepared, { kind: "ignored" }>;

type Phase =
  | { kind: "idle" }
  | { kind: "reading"; done: number; total: number }
  | { kind: "ready"; documents: Ready[]; blocked: Blocked[]; ignored: Ignored[] }
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

  /**
   * Reads and converts everything, then shows what will happen.
   *
   * The extraction runs here rather than at import time so the preview is the
   * truth: a .docx that cannot be parsed, or a .gdoc that holds no text, is
   * seen before anything is sent rather than turning up as a failed row after.
   */
  const accept = useCallback(async (found: Candidate[]) => {
    const capped = found
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, MAX_FILES);

    setError(null);
    setPhase({ kind: "reading", done: 0, total: capped.length });

    const prepared: Prepared[] = [];
    for (const [index, candidate] of capped.entries()) {
      prepared.push(...(await prepareFile(candidate.path, candidate.file)));
      setPhase({ kind: "reading", done: index + 1, total: capped.length });
    }

    const documents = prepared.filter((p): p is Ready => p.kind === "ready");
    const blocked = prepared.filter((p): p is Blocked => p.kind === "blocked");
    const ignored = prepared.filter((p): p is Ignored => p.kind === "ignored");

    if (documents.length === 0) {
      setPhase({ kind: "idle" });
      setError(
        blocked.length > 0
          ? `Nothing could be read. ${blocked[0].reason}`
          : `Nothing importable there — looked for ${ACCEPTED_DESCRIPTION}.`,
      );
      return;
    }
    setPhase({ kind: "ready", documents, blocked, ignored });
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      setError(null);
      setPhase({ kind: "reading", done: 0, total: 0 });

      try {
        await accept(await collectFromDrop(event.dataTransfer));
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
    const { documents: all, blocked, ignored } = phase;

    setError(null);
    setPhase({ kind: "importing", done: 0, total: all.length });
    const items: ImportedItem[] = [];

    try {
      for (let i = 0; i < all.length; i += BATCH_SIZE) {
        const documents = all
          .slice(i, i + BATCH_SIZE)
          .map((d) => ({ path: d.path, content: d.markdown }));

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
          done: Math.min(i + BATCH_SIZE, all.length),
          total: all.length,
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
          : { kind: "ready", documents: all, blocked, ignored },
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
          {ACCEPTED_DESCRIPTION} · subfolders and archives are opened · up to{" "}
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
          accept=".docx,.md,.markdown,.txt,.zip,.gdoc"
          hidden
          onChange={(e) => {
            void accept(fromFileList(e.target.files));
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
            void accept(fromFileList(e.target.files));
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

      {phase.kind === "reading" && (
        <p className="hint" role="status">
          Reading{phase.total > 0 ? ` ${phase.done} of ${phase.total}` : ""}…
        </p>
      )}

      {phase.kind === "ready" && (
        <Preview
          documents={phase.documents}
          blocked={phase.blocked}
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
  documents,
  blocked,
  ignored,
  onCancel,
  onConfirm,
}: {
  documents: Ready[];
  blocked: Blocked[];
  ignored: Ignored[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="import-preview">
      <div className="import-preview-head">
        <h2 className="label">
          {documents.length} document{documents.length === 1 ? "" : "s"} ready
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
        {documents.map((document) => (
          <li key={document.path}>
            <span className="import-list-path">{document.path}</span>
            {/* What was lost on the way in, said at the point it happened. */}
            {document.notes.length > 0 && (
              <span className="meta">{document.notes.join(" · ")}</span>
            )}
          </li>
        ))}
      </ul>

      {blocked.length > 0 && (
        <>
          <h2 className="label">Could not be read</h2>
          <ul className="import-blocked">
            {blocked.map((entry) => (
              <li key={entry.path}>
                <span className="import-list-path">{entry.path}</span>
                <span className="meta">
                  {entry.reason}
                  {entry.url && (
                    <>
                      {" "}
                      <a href={entry.url} target="_blank" rel="noopener noreferrer">
                        Open in Google Docs ↗
                      </a>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {ignored.length > 0 && (
        <p className="hint">
          {ignored.length} other file{ignored.length === 1 ? "" : "s"} ignored —
          only {ACCEPTED_DESCRIPTION} can be read.
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
