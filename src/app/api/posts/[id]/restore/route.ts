import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { handle, json } from "@/lib/http";
import { restorePost } from "@/lib/posts";
import { affectsPublicOutput, revalidatePublicPages } from "@/lib/revalidate";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** POST /api/posts/:id/restore — bring a post back out of the trash. */
export const POST = handle(async (_request: NextRequest, context: RouteContext) => {
  const { id: raw } = await context.params;
  const id = uuidSchema.parse(raw);

  const db = getDb();
  const post = await restorePost(db, id);

  // A restored published post reappears at its URL and in every list.
  if (affectsPublicOutput(post.status)) {
    await revalidatePublicPages(db, {
      slugs: [post.slug],
      tagSlugs: post.tags.map((tag) => tag.slug),
      seriesIds: [post.series_id],
    });
  }
  return json({ post });
});
