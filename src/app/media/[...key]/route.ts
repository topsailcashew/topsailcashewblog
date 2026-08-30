import { handle } from "@/lib/http";
import { getMediaBucket } from "@/lib/r2";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ key: string[] }> };

const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * GET /media/<key> — streams an object back out of R2.
 *
 * This keeps the bucket private and makes uploads work with no extra setup.
 * Setting R2_PUBLIC_BASE_URL points new uploads at a CDN domain instead;
 * objects already stored keep resolving through here.
 *
 * Headers are built from `object.httpMetadata` rather than R2's
 * `writeHttpMetadata(headers)` helper: in `next dev` the binding is an RPC
 * proxy to miniflare, and a `Headers` instance cannot cross that boundary.
 */
export const GET = handle(async (request: Request, context: RouteContext) => {
  const { key: segments } = await context.params;
  const key = segments.map(decodeURIComponent).join("/");

  const object = await (await getMediaBucket()).get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const metadata = object.httpMetadata;
  const headers = new Headers({
    "content-type": metadata?.contentType ?? "application/octet-stream",
    "cache-control": metadata?.cacheControl ?? DEFAULT_CACHE_CONTROL,
    etag: object.httpEtag,
    // Uploads are sniffed on the way in; never let a browser second-guess it.
    "x-content-type-options": "nosniff",
  });

  // Images are immutable, so a revisit should cost a 304 and no bytes.
  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
});
