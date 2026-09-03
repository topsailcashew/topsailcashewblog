/**
 * Intrinsic image metadata, read from the file's own header bytes.
 *
 * ## Why parse headers rather than decode
 *
 * The Workers runtime has no image decoder, and shipping one would not fit
 * inside the 3 MB bundle even if it did. But dimensions and EXIF do not
 * *need* a decode — both live in a fixed structure at the front of the file,
 * a few hundred bytes in. So they are read here, on the server, which means
 * every upload gets them regardless of which client made it.
 *
 * The blur placeholder is the one thing that genuinely requires pixels. That
 * is produced in the browser at upload time and posted alongside the file —
 * see src/lib/image-placeholder.ts.
 *
 * ## On GPS
 *
 * The GPS IFD is deliberately never read. A photo taken on a phone routinely
 * carries the coordinates of the house it was taken in, and the only thing
 * standing between that and a public page is nobody having written the code
 * to extract it. This is that code, and it declines.
 */

export type ImageDimensions = { width: number; height: number };

export type ExifData = {
  make?: string;
  model?: string;
  lens?: string;
  taken_at?: string;
  /** 1–8, per the TIFF spec. 1 is "as stored". */
  orientation?: number;
  exposure?: string;
  aperture?: string;
  iso?: number;
  focal_length?: string;
};

/* --- dimensions ---------------------------------------------------------- */

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;

  if (bytes[0] === 0x89 && bytes[1] === 0x50) return pngSize(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return gifSize(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return webpSize(bytes);
  if (ascii(bytes, 4, 8) === "ftyp") return isobmffSize(bytes);
  return null;
}

/** IHDR is always the first chunk, and always at byte 16. */
function pngSize(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Little-endian, immediately after the "GIF89a" signature. */
function gifSize(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/**
 * JPEG has no fixed header — the size lives in a start-of-frame marker
 * somewhere after an arbitrary run of metadata segments, so the segment chain
 * has to be walked. Any SOFn but the four that are not frames carries it.
 */
function jpegSize(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1; // Resynchronise past padding rather than give up.
      continue;
    }
    const marker = bytes[offset + 1];

    // Standalone markers: no length field to skip over.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: compressed data from here on, and no frame header left.
    if (marker === 0xda) return null;

    const length = view.getUint16(offset + 2);
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      // C4 is a Huffman table, C8 a JPEG extension, CC arithmetic coding.
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isFrame) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** Three variants, three layouts. */
function webpSize(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = ascii(bytes, 12, 16);

  if (format === "VP8X" && bytes.length >= 30) {
    // 24-bit little-endian, stored as (dimension - 1).
    const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    return { width, height };
  }
  if (format === "VP8 " && bytes.length >= 30) {
    // The top two bits of each field are the scaling factor, not size.
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (format === "VP8L" && bytes.length >= 25) {
    // 14 bits each, packed across four bytes with no alignment.
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

/**
 * AVIF and HEIC: ISOBMFF, where the size lives in an `ispe` box nested several
 * containers deep. Rather than walk the box tree, scan the first few kilobytes
 * for the signature — the header sits at the front of the file by construction,
 * and a full parse would be a great deal of code to reach the same eight bytes.
 */
function isobmffSize(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const limit = Math.min(bytes.length - 12, 8192);

  for (let offset = 0; offset < limit; offset += 1) {
    if (
      bytes[offset] === 0x69 && // i
      bytes[offset + 1] === 0x73 && // s
      bytes[offset + 2] === 0x70 && // p
      bytes[offset + 3] === 0x65 // e
    ) {
      // Four bytes of version and flags sit between the box name and the size.
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (width > 0 && height > 0 && width < 100000 && height < 100000) {
        return { width, height };
      }
    }
  }
  return null;
}

/* --- EXIF ---------------------------------------------------------------- */

const TAGS = {
  MAKE: 0x010f,
  MODEL: 0x0110,
  ORIENTATION: 0x0112,
  EXIF_IFD: 0x8769,
  EXPOSURE_TIME: 0x829a,
  F_NUMBER: 0x829d,
  ISO: 0x8827,
  DATE_TIME_ORIGINAL: 0x9003,
  FOCAL_LENGTH: 0x920a,
  LENS_MODEL: 0xa434,
} as const;

/**
 * Reads the camera fields out of a JPEG's APP1 segment.
 *
 * Returns null rather than throwing for anything malformed. EXIF in the wild
 * is frequently truncated, mis-sized, or written by software that guessed —
 * a photo with a broken header should still upload.
 */
export function extractExif(bytes: Uint8Array): ExifData | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return null; // Image data begins.

    const length = view.getUint16(offset + 2);
    if (length < 2) return null;

    if (marker === 0xe1 && ascii(bytes, offset + 4, offset + 8) === "Exif") {
      try {
        return readTiff(view, offset + 10, Math.min(offset + 2 + length, bytes.length));
      } catch {
        return null;
      }
    }
    offset += 2 + length;
  }
  return null;
}

function readTiff(view: DataView, base: number, end: number): ExifData | null {
  if (base + 8 > end) return null;

  // "II" is Intel (little-endian), "MM" Motorola (big). Both are common;
  // assuming either one is how half the EXIF parsers on the internet break.
  const byteOrder = view.getUint16(base);
  const little = byteOrder === 0x4949;
  if (!little && byteOrder !== 0x4d4d) return null;
  if (view.getUint16(base + 2, little) !== 0x002a) return null;

  const ifd0 = base + view.getUint32(base + 4, little);
  const exif: ExifData = {};

  const entries = readIfd(view, base, ifd0, end, little);
  applyTags(view, base, end, little, entries, exif);

  // The interesting fields — shutter, aperture, lens — live in a sub-IFD
  // that IFD0 only points at.
  const exifPointer = entries.get(TAGS.EXIF_IFD);
  if (exifPointer !== undefined) {
    const sub = readIfd(view, base, base + Number(exifPointer.value), end, little);
    applyTags(view, base, end, little, sub, exif);
  }

  return Object.keys(exif).length > 0 ? exif : null;
}

type Entry = { type: number; count: number; value: number; valueOffset: number };

function readIfd(
  view: DataView,
  base: number,
  offset: number,
  end: number,
  little: boolean,
): Map<number, Entry> {
  const entries = new Map<number, Entry>();
  if (offset + 2 > end) return entries;

  const count = view.getUint16(offset, little);
  // A corrupt count can be enormous; cap it rather than walk off the buffer.
  for (let index = 0; index < Math.min(count, 200); index += 1) {
    const at = offset + 2 + index * 12;
    if (at + 12 > end) break;

    const tag = view.getUint16(at, little);
    const type = view.getUint16(at + 2, little);
    const items = view.getUint32(at + 4, little);
    // Values of four bytes or fewer are stored inline; anything larger is an
    // offset from the TIFF header.
    const inline = typeSize(type) * items <= 4;
    entries.set(tag, {
      type,
      count: items,
      value: inline ? readValue(view, at + 8, type, little) : view.getUint32(at + 8, little),
      valueOffset: inline ? at + 8 : base + view.getUint32(at + 8, little),
    });
  }
  return entries;
}

function applyTags(
  view: DataView,
  base: number,
  end: number,
  little: boolean,
  entries: Map<number, Entry>,
  exif: ExifData,
): void {
  const text = (tag: number) => {
    const entry = entries.get(tag);
    if (!entry || entry.type !== 2) return undefined;
    return readAscii(view, entry.valueOffset, entry.count, end);
  };

  /*
    Assigns only when there is something to assign.

    `exif.make ??= text(...)` reads correctly and is wrong: assigning
    `undefined` *creates the key*. Every field would then exist on every
    photo, `Object.keys(exif).length > 0` would always be true, and a JPEG
    with no EXIF at all would be stored as `{}` rather than null — a row that
    claims to have metadata and does not.
  */
  function set<K extends keyof ExifData>(key: K, value: ExifData[K] | undefined): void {
    if (value !== undefined && exif[key] === undefined) exif[key] = value;
  }

  set("make", text(TAGS.MAKE));
  set("model", text(TAGS.MODEL));
  set("lens", text(TAGS.LENS_MODEL));

  const taken = text(TAGS.DATE_TIME_ORIGINAL);
  // EXIF writes "2026:08:30 14:22:07", which is not a date any parser accepts.
  if (taken) set("taken_at", taken.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"));

  const orientation = entries.get(TAGS.ORIENTATION);
  if (orientation && orientation.value >= 1 && orientation.value <= 8) {
    set("orientation", orientation.value);
  }

  const iso = entries.get(TAGS.ISO);
  if (iso && iso.value > 0 && iso.value < 1_000_000) set("iso", iso.value);

  const exposure = rational(view, entries.get(TAGS.EXPOSURE_TIME), end, little);
  if (exposure !== null) {
    // Photographers read "1/250", not "0.004".
    set("exposure", exposure >= 1 ? `${round(exposure, 1)}s` : `1/${Math.round(1 / exposure)}`);
  }

  const aperture = rational(view, entries.get(TAGS.F_NUMBER), end, little);
  if (aperture !== null) set("aperture", `f/${round(aperture, 1)}`);

  const focal = rational(view, entries.get(TAGS.FOCAL_LENGTH), end, little);
  if (focal !== null) set("focal_length", `${Math.round(focal)}mm`);
}

/** Type 5 is two uint32s: numerator then denominator. */
function rational(
  view: DataView,
  entry: Entry | undefined,
  end: number,
  little: boolean,
): number | null {
  if (!entry || entry.type !== 5) return null;
  if (entry.valueOffset + 8 > end) return null;

  const numerator = view.getUint32(entry.valueOffset, little);
  const denominator = view.getUint32(entry.valueOffset + 4, little);
  if (denominator === 0) return null;
  return numerator / denominator;
}

function readAscii(view: DataView, offset: number, count: number, end: number): string | undefined {
  if (offset < 0 || offset + count > end) return undefined;
  let value = "";
  for (let index = 0; index < Math.min(count, 200); index += 1) {
    const byte = view.getUint8(offset + index);
    if (byte === 0) break; // EXIF strings are NUL-terminated.
    value += String.fromCharCode(byte);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readValue(view: DataView, offset: number, type: number, little: boolean): number {
  switch (type) {
    case 1:
    case 6:
      return view.getUint8(offset);
    case 3:
    case 8:
      return view.getUint16(offset, little);
    default:
      return view.getUint32(offset, little);
  }
}

function typeSize(type: number): number {
  switch (type) {
    case 1:
    case 2:
    case 6:
    case 7:
      return 1;
    case 3:
    case 8:
      return 2;
    case 4:
    case 9:
      return 4;
    default:
      return 8;
  }
}

function round(value: number, places: number): string {
  return String(Number(value.toFixed(places)));
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}
