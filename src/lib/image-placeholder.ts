"use client";

/**
 * Blur placeholders, generated in the browser at upload time.
 *
 * This is the one piece of image metadata that genuinely needs pixels: you
 * cannot average colours you have not decoded. The Workers runtime has no
 * image decoder and could not afford one inside a 3 MB bundle — but every
 * browser already has a very good one, and the file is sitting in it anyway.
 * So the work happens here, once, and the result is posted alongside the
 * upload.
 *
 * Two outputs, because they are good at different things:
 *
 *   BlurHash — ~30 characters, decodes to a smooth gradient. Cheap to store
 *     anywhere and the better *look*, but needs a decoder on the page.
 *   LQIP — a real image as a data URI, ~1 kB. Larger, but it is just an
 *     `<img src>` or a CSS background: no JavaScript on the reading page,
 *     which is the point of this blog.
 *
 * Both are best-effort. A browser that refuses (a tainted canvas, an
 * unsupported format, storage pressure) returns null and the upload proceeds
 * without them — a missing placeholder is a slightly duller page load, not a
 * failed upload.
 */

export type ImagePlaceholder = {
  width: number;
  height: number;
  blurhash: string | null;
  lqip: string | null;
};

/** The LQIP's long edge, in pixels. Twenty is enough to read as a shape. */
const LQIP_EDGE = 20;

/** Anything larger than this is not a placeholder any more. */
const MAX_LQIP_BYTES = 3000;

export async function buildPlaceholder(file: File): Promise<ImagePlaceholder | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = bitmap;
      const scale = LQIP_EDGE / Math.max(width, height);
      const smallWidth = Math.max(1, Math.round(width * scale));
      const smallHeight = Math.max(1, Math.round(height * scale));

      const canvas = makeCanvas(smallWidth, smallHeight);
      /*
        Narrowed by hand. `getContext("2d")` on the union of the two canvas
        types widens to include every rendering context, most of which have
        no `drawImage` — but both 2D contexts do, and the union is only there
        because OffscreenCanvas is unavailable in some browsers.
      */
      const context = canvas.getContext("2d", { willReadFrequently: true }) as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!context) return { width, height, blurhash: null, lqip: null };

      context.drawImage(bitmap, 0, 0, smallWidth, smallHeight);
      const pixels = context.getImageData(0, 0, smallWidth, smallHeight);

      return {
        width,
        height,
        blurhash: safely(() => encodeBlurhash(pixels.data, smallWidth, smallHeight, 4, 3)),
        lqip: await toDataUri(canvas),
      };
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * WebP first, JPEG as the fallback.
 *
 * At twenty pixels WebP is routinely half the size of the equivalent JPEG,
 * and the difference decides whether this fits in a column that gets inlined
 * into every page the image appears on.
 */
async function toDataUri(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string | null> {
  for (const type of ["image/webp", "image/jpeg"]) {
    const uri = await encodeCanvas(canvas, type);
    // A browser that cannot encode WebP silently returns a PNG instead, which
    // is far too large — so the result is checked rather than trusted.
    if (uri && uri.startsWith(`data:${type}`) && uri.length <= MAX_LQIP_BYTES) {
      return uri;
    }
  }
  return null;
}

async function encodeCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
): Promise<string | null> {
  try {
    if (canvas instanceof OffscreenCanvas) {
      const blob = await canvas.convertToBlob({ type, quality: 0.6 });
      return await blobToDataUri(blob);
    }
    return canvas.toDataURL(type, 0.6);
  } catch {
    return null;
  }
}

function blobToDataUri(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function safely<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}

/* --- BlurHash ------------------------------------------------------------ */

/*
  An implementation of Wolt's BlurHash encoder (MIT). Written out rather than
  installed: the reference package is small, but every dependency in this
  Worker is measured against a hard 3 MB ceiling, and this is forty lines of
  arithmetic with no reason to change.

  The idea: project the image onto a handful of 2-D cosine basis functions —
  a discrete cosine transform kept to its lowest few terms — and write the
  coefficients in base 83. Four by three components is the usual choice; it
  captures the broad arrangement of light without any recognisable detail.
*/

const BASE83 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

export function encodeBlurhash(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  componentsX: number,
  componentsY: number,
): string {
  const factors: [number, number, number][] = [];

  for (let y = 0; y < componentsY; y += 1) {
    for (let x = 0; x < componentsX; x += 1) {
      // The DC term is an average; every AC term is doubled because the
      // cosine basis only covers half the period.
      const normalisation = x === 0 && y === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;

      for (let i = 0; i < width; i += 1) {
        for (let j = 0; j < height; j += 1) {
          const basis =
            normalisation *
            Math.cos((Math.PI * x * i) / width) *
            Math.cos((Math.PI * y * j) / height);
          const offset = 4 * i + j * 4 * width;
          // Averaged in linear light. Averaging sRGB values directly is the
          // classic mistake — it makes every blur darker than the image.
          r += basis * srgbToLinear(rgba[offset]);
          g += basis * srgbToLinear(rgba[offset + 1]);
          b += basis * srgbToLinear(rgba[offset + 2]);
        }
      }

      const scale = 1 / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }

  const dc = factors[0];
  const ac = factors.slice(1);

  let hash = encode83((componentsX - 1) + (componentsY - 1) * 9, 1);

  let maximum = 1;
  if (ac.length > 0) {
    const peak = Math.max(...ac.map((factor) => Math.max(...factor.map(Math.abs))));
    const quantised = Math.max(0, Math.min(82, Math.floor(peak * 166 - 0.5)));
    maximum = (quantised + 1) / 166;
    hash += encode83(quantised, 1);
  } else {
    hash += encode83(0, 1);
  }

  hash += encode83(encodeDc(dc), 4);
  for (const factor of ac) hash += encode83(encodeAc(factor, maximum), 2);
  return hash;
}

function encodeDc([r, g, b]: [number, number, number]): number {
  return (linearToSrgb(r) << 16) + (linearToSrgb(g) << 8) + linearToSrgb(b);
}

function encodeAc([r, g, b]: [number, number, number], maximum: number): number {
  const quantise = (value: number) =>
    Math.max(0, Math.min(18, Math.floor(signPow(value / maximum, 0.5) * 9 + 9.5)));
  return quantise(r) * 19 * 19 + quantise(g) * 19 + quantise(b);
}

function encode83(value: number, length: number): string {
  let result = "";
  for (let index = 1; index <= length; index += 1) {
    const digit = Math.floor(value / 83 ** (length - index)) % 83;
    result += BASE83[digit];
  }
  return result;
}

function srgbToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const channel = Math.max(0, Math.min(1, value));
  return channel <= 0.0031308
    ? Math.round(channel * 12.92 * 255 + 0.5)
    : Math.round((1.055 * channel ** (1 / 2.4) - 0.055) * 255 + 0.5);
}

/** Raises the magnitude to a power while keeping the sign. */
function signPow(value: number, exponent: number): number {
  return Math.sign(value) * Math.abs(value) ** exponent;
}
