import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { readOpenToken } from "@/lib/email/tokens";
import { recordOpen } from "@/lib/newsletter";

export const dynamic = "force-dynamic";

/**
 * The open pixel.
 *
 * A 1x1 transparent GIF, 43 bytes, inlined below rather than fetched from
 * anywhere. Always returns the image — a bad token, a deleted send or an
 * unreachable database all produce the same picture, because a broken image
 * icon in someone's email is a worse outcome than a missed statistic.
 *
 * Open tracking is an estimate and should be read as one. Apple Mail Privacy
 * Protection pre-fetches images for every message, which inflates opens; every
 * other client blocks them by default, which deflates them. The number is
 * useful compared against this blog's own past sends and useless in absolute
 * terms — which is exactly how the dashboard presents it.
 */
const PIXEL = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const secret = getSessionSecret();
    if (secret) {
      const { token } = await context.params;
      const sendId = await readOpenToken(token, secret);
      if (sendId) await recordOpen(getDb(), sendId);
    }
  } catch (error) {
    console.warn("Could not record an open:", error);
  }

  return new Response(PIXEL, {
    headers: {
      "content-type": "image/gif",
      // Must not be cached: a cached pixel is a reader whose second open is
      // never seen, and a CDN copy would serve one reader's token to another.
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "content-length": String(PIXEL.length),
    },
  });
}
