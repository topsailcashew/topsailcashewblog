import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * Phase 1 needs no incremental cache — the API routes are force-dynamic and
 * there are no statically generated pages yet. Phase 3 turns the public post
 * pages into ISR, which is where an R2 incremental cache gets wired in here.
 */
export default defineCloudflareConfig();
