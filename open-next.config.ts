import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
import kvTagCache from "@opennextjs/cloudflare/overrides/tag-cache/kv-next-tag-cache";

/**
 * Caching for the public site.
 *
 * The reading pages are ISR: rendered once, served from KV afterwards, and
 * invalidated by `revalidatePath` when a post is written (see
 * `src/lib/revalidate.ts`). Workers KV is the store for both the rendered
 * pages and the cache tags — no D1 or Durable Objects, so this stays on the
 * free plan.
 *
 * `queue: "direct"` revalidates inline instead of going through a Durable
 * Object queue. At this traffic level a queue would be machinery with nothing
 * to coalesce.
 */
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  tagCache: kvTagCache,
  queue: "direct",
});
