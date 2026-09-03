import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { posts } from "@/db/schema";
import { AP_CONTENT_TYPE } from "@/lib/activitypub/actor";
import { buildNote } from "@/lib/activitypub/activities";
import { loadFediverseSettings } from "@/lib/activitypub/keys";
import { getTagsForPosts } from "@/lib/tags";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * One post as a dereferenceable Note.
 *
 * Needed because a reply carries `inReplyTo` pointing here, and the replying
 * server fetches it to check the object exists and is public before it will
 * show the reply in a thread. Without this endpoint, replies from the
 * fediverse are dropped by the *sender* and never arrive.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const settings = await loadFediverseSettings(db).catch(() => null);
  if (!settings?.enabled) return new Response("Not found", { status: 404 });

  const { id: raw } = await context.params;
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) return new Response("Not found", { status: 404 });

  const [row] = await db
    .select({
      id: posts.id,
      title: posts.title,
      slug: posts.slug,
      excerpt: posts.excerpt,
      publishedAt: posts.publishedAt,
      coverImageUrl: posts.coverImageUrl,
      status: posts.status,
      deletedAt: posts.deletedAt,
    })
    .from(posts)
    .where(eq(posts.id, parsed.data))
    .limit(1);

  // The same three conditions the reading page applies. A draft or a scheduled
  // post must not be dereferenceable here either — this endpoint would
  // otherwise be a way to read unpublished work by guessing an id.
  const live =
    row &&
    row.status === "published" &&
    row.deletedAt === null &&
    row.publishedAt !== null &&
    row.publishedAt.getTime() <= Date.now();
  if (!live) return new Response("Not found", { status: 404 });

  const tags = (await getTagsForPosts(db, [row.id])).get(row.id) ?? [];

  return Response.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      ...buildNote({
        id: row.id,
        title: row.title,
        slug: row.slug,
        excerpt: row.excerpt,
        published_at: row.publishedAt?.toISOString() ?? null,
        cover_image_url: row.coverImageUrl,
        tags,
      }),
    },
    { headers: { "content-type": AP_CONTENT_TYPE } },
  );
}
