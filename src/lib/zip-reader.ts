/**
 * Just enough ZIP to read a .docx or a Drive folder download.
 *
 * Browser-side only. No dependency: `DecompressionStream("deflate-raw")` is
 * the inflater, which every current browser has, and the container format is
 * a few structs. A zip library would be several tens of kilobytes shipped to
 * the admin for something the platform already does.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const STORED = 0;
const DEFLATE = 8;

export type ZipEntries = Map<string, Uint8Array>;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/**
 * Every file in the archive, by path.
 *
 * The central directory is read rather than the local headers scanned: it is
 * the authoritative index, and a local header may declare sizes of zero and
 * defer them to a trailing descriptor, which a naive forward scan reads as an
 * empty file.
 */
export async function readZip(bytes: Uint8Array): Promise<ZipEntries> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);

  const entries: ZipEntries = new Map();

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError("Damaged archive: bad central directory entry");
    }

    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    const name = new TextDecoder().decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );

    // Directories are entries too, and have nothing to read.
    if (!name.endsWith("/")) {
      entries.set(name, await readOne(bytes, view, localOffset, method, compressedSize));
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function readOne(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
): Promise<Uint8Array> {
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    throw new ZipError("Damaged archive: bad local file header");
  }

  // The local header repeats the name and extra fields, at its own lengths.
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + compressedSize);

  if (method === STORED) return data;
  if (method !== DEFLATE) {
    throw new ZipError(`Unsupported compression in the archive (method ${method})`);
  }
  return inflateRaw(data);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The end-of-central-directory record, searched backwards.
 *
 * It sits at the very end unless the archive carries a comment, so the scan
 * covers the largest comment the format allows plus the record itself.
 */
function findEndOfCentralDirectory(view: DataView): number {
  const maxComment = 0xffff;
  const earliest = Math.max(0, view.byteLength - maxComment - 22);

  for (let i = view.byteLength - 22; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError("That does not look like a zip archive");
}

/** Decodes one entry as UTF-8 text. */
export function entryText(entries: ZipEntries, path: string): string | null {
  const bytes = entries.get(path);
  return bytes ? new TextDecoder().decode(bytes) : null;
}
