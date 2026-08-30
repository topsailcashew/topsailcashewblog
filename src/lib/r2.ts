import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Access to the media bucket.
 *
 * We use the R2 *binding* rather than the S3 API: no access keys to rotate or
 * leak, and `wrangler dev` / `next dev` back it with a real local bucket, so
 * the upload path is exercised for real in development.
 */
export async function getMediaBucket(): Promise<R2Bucket> {
  const { env } = await getCloudflareContext({ async: true });
  const bucket = env.MEDIA_BUCKET;
  if (!bucket) {
    throw new Error(
      "MEDIA_BUCKET binding is missing. Check the r2_buckets entry in wrangler.jsonc.",
    );
  }
  return bucket;
}

/**
 * Public URL for a stored object.
 *
 * With no R2_PUBLIC_BASE_URL configured, images are served back through the
 * Worker at /media/<key>. That works out of the box and keeps the bucket
 * private; point R2_PUBLIC_BASE_URL at an r2.dev or custom domain to serve
 * them from the CDN edge instead.
 */
export function publicUrlForKey(key: string): string {
  const base = process.env.R2_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return base ? `${base}/${encoded}` : `/media/${encoded}`;
}
