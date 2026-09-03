import { getDb } from "@/db/client";
import { AP_CONTENT_TYPE } from "@/lib/activitypub/actor";
import { buildOutbox, type FederatedPost } from "@/lib/activitypub/activities";
import { loadFediverseSettings } from "@/lib/activitypub/keys";
import { countPublished, listPublishedForFeed } from "@/lib/public-posts";

/** Five minutes, matching every other public listing. */
export const revalidate = 300;

/**
 * The outbox: every published post as a Create activity.
 *
 * Unpaged, and inlined rather than linked. The specification allows a paged
 * OrderedCollection and most large accounts need one; a personal blog's whole
 * archive fits in a single response, and a first page that only points at
 * another page is a round trip for nothing.
 */
export async function GET() {
  const db = getDb();

  const settings = await loadFediverseSettings(db).catch(() => null);
  if (!settings?.enabled) return new Response("Not found", { status: 404 });

  const [items, total] = await Promise.all([
    listPublishedForFeed(db, 100),
    countPublished(db),
  ]);

  const federated: FederatedPost[] = items.map((post) => ({
    id: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    published_at: post.published_at,
    cover_image_url: post.cover_image_url,
    tags: post.tags,
  }));

  return Response.json(buildOutbox(federated, total), {
    headers: { "content-type": AP_CONTENT_TYPE },
  });
}
