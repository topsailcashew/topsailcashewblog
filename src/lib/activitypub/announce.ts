import type { BlogDatabase } from "@/db/client";
import type { SerializedPost } from "../posts";
import { federatePost } from "./delivery";
import { ensureKeyPair, loadFediverseSettings } from "./keys";

/**
 * Broadcasts a post to followers, if it should be broadcast at all.
 *
 * One place, called from every route that can publish, so the conditions live
 * together rather than being restated at each call site:
 *
 *  - federation is switched on
 *  - the post is published *and* its date has arrived (a scheduled post must
 *    not appear in a timeline before it appears on the site)
 *  - it is not marked noindex, which is the author saying "live, but do not
 *    spread this"
 *  - it has not been federated before — enforced in `federatePost` by a
 *    conditional write, so two concurrent publishes cannot both announce it
 *
 * Never throws. A publish that succeeded must not be reported as a failure
 * because an instance somewhere was unreachable.
 */
export async function announceIfPublished(
  db: BlogDatabase,
  post: SerializedPost,
  sessionSecret: string | undefined,
): Promise<void> {
  try {
    if (!sessionSecret) return;
    if (post.status !== "published" || post.noindex) return;

    const publishedAt = post.published_at ? new Date(post.published_at).getTime() : null;
    if (publishedAt === null || publishedAt > Date.now()) return;

    const settings = await loadFediverseSettings(db);
    if (!settings.enabled) return;

    const { privateKeyPem } = await ensureKeyPair(db, sessionSecret);
    const result = await federatePost(
      db,
      {
        id: post.id,
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        published_at: post.published_at,
        cover_image_url: post.cover_image_url,
        tags: post.tags,
      },
      privateKeyPem,
    );

    if (!result.skipped) {
      console.info(
        `Federated ${post.slug}: ${result.delivered}/${result.inboxes} inboxes`,
      );
    }
  } catch (error) {
    console.warn("Could not federate the post:", error);
  }
}
