import { getAccessToken, type ServiceAccount } from "./google-auth";

/**
 * The slice of the Drive v3 REST API this blog needs: walk a folder tree and
 * read the documents in it. Plain `fetch` — see `google-auth.ts` for why there
 * is no SDK.
 */

const FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

/**
 * What a Google Doc is exported as.
 *
 * Markdown, not HTML. Docs' HTML export is a thicket of inline styles and
 * wrapper spans that would have to be stripped back to the handful of nodes
 * the editor actually supports; its Markdown export is already close to that
 * shape.
 */
const DOC_EXPORT_MIME = "text/markdown";

/** Plain files we will read directly rather than export. */
const READABLE_MIMES = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
]);

/**
 * Depth and breadth caps.
 *
 * A shared Drive folder is not under this app's control: it could be nested
 * arbitrarily, or contain thousands of files, and a Worker has a wall-clock
 * budget. Both limits are reported back rather than silently applied.
 */
export const MAX_DEPTH = 5;
export const MAX_FILES = 100;
const PAGE_SIZE = 100;

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  /** Folder names from the root down, for a breadcrumb in the report. */
  path: string[];
};

export type DriveListing = {
  files: DriveFile[];
  /** True when a cap stopped the walk before it finished. */
  truncated: boolean;
  skipped: { name: string; reason: string }[];
};

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

/** Anything that can talk to Drive. Swapped for a stub in tests. */
export type DriveClient = {
  listFolder(folderId: string): Promise<DriveListing>;
  readFile(file: DriveFile): Promise<string>;
};

async function driveFetch(
  token: string,
  url: string,
): Promise<Response> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.ok) return response;

  const detail = await response.text().catch(() => "");
  if (response.status === 404) {
    throw new DriveError(
      "Drive returned 404. Check the folder id, and that the folder is shared " +
        "with the service account address.",
      404,
    );
  }
  if (response.status === 403) {
    throw new DriveError(
      "Drive returned 403. The service account can authenticate but cannot see " +
        "this folder — share it with the service account address, or enable the " +
        "Drive API for the project.",
      403,
    );
  }
  throw new DriveError(
    `Drive request failed (${response.status}). ${detail.slice(0, 200)}`,
    response.status,
  );
}

/** Escapes a value for a Drive query string literal. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function createDriveClient(account: ServiceAccount): DriveClient {
  return {
    async listFolder(folderId: string): Promise<DriveListing> {
      const token = await getAccessToken(account);
      const files: DriveFile[] = [];
      const skipped: { name: string; reason: string }[] = [];
      let truncated = false;

      // Breadth-first, so a wide folder is not starved by one deep branch.
      const queue: { id: string; path: string[]; depth: number }[] = [
        { id: folderId, path: [], depth: 0 },
      ];

      while (queue.length > 0) {
        const current = queue.shift()!;
        let pageToken: string | undefined;

        do {
          const params = new URLSearchParams({
            q: `${quote(current.id)} in parents and trashed = false`,
            fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
            pageSize: String(PAGE_SIZE),
            // Shared drives are not assumed, but cost nothing to support.
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
          });
          if (pageToken) params.set("pageToken", pageToken);

          const response = await driveFetch(token, `${FILES_ENDPOINT}?${params}`);
          const body = (await response.json()) as {
            files?: Omit<DriveFile, "path">[];
            nextPageToken?: string;
          };

          for (const entry of body.files ?? []) {
            if (entry.mimeType === FOLDER_MIME) {
              if (current.depth + 1 > MAX_DEPTH) {
                skipped.push({
                  name: entry.name,
                  reason: `nested deeper than ${MAX_DEPTH} folders`,
                });
                continue;
              }
              queue.push({
                id: entry.id,
                path: [...current.path, entry.name],
                depth: current.depth + 1,
              });
              continue;
            }

            if (!isImportable(entry.mimeType)) {
              skipped.push({ name: entry.name, reason: describeMime(entry.mimeType) });
              continue;
            }

            if (files.length >= MAX_FILES) {
              truncated = true;
              continue;
            }
            files.push({ ...entry, path: current.path });
          }

          pageToken = body.nextPageToken;
        } while (pageToken);
      }

      return { files, truncated, skipped };
    },

    async readFile(file: DriveFile): Promise<string> {
      const token = await getAccessToken(account);

      // A Google Doc has no bytes to download — it must be exported.
      const url =
        file.mimeType === GOOGLE_DOC_MIME
          ? `${FILES_ENDPOINT}/${file.id}/export?${new URLSearchParams({
              mimeType: DOC_EXPORT_MIME,
            })}`
          : `${FILES_ENDPOINT}/${file.id}?${new URLSearchParams({
              alt: "media",
              supportsAllDrives: "true",
            })}`;

      const response = await driveFetch(token, url);
      return response.text();
    },
  };
}

export function isImportable(mimeType: string): boolean {
  return mimeType === GOOGLE_DOC_MIME || READABLE_MIMES.has(mimeType);
}

/** Why a file was passed over, in words the writer will recognise. */
function describeMime(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "an image, not a document";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "a spreadsheet";
  if (mimeType === "application/vnd.google-apps.presentation") return "a presentation";
  if (mimeType === "application/pdf") return "a PDF";
  if (mimeType.includes("wordprocessingml")) {
    return "a .docx — open it in Google Docs first";
  }
  return `unsupported type (${mimeType})`;
}
