import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { handle, json, readJsonBody } from "@/lib/http";
import { createPost, listPosts } from "@/lib/posts";
import { affectsPublicOutput, revalidatePublicPages } from "@/lib/revalidate";
import { createPostSchema, parseListQuery } from "@/lib/validation";

// Reads hit Postgres on every request; nothing here is prerenderable.
// Phase 3 makes the *public* routes static — these admin endpoints stay dynamic.
export const dynamic = "force-dynamic";

/** GET /api/posts?status=draft|published&limit=&offset= */
export const GET = handle(async (request: NextRequest) => {
  const query = parseListQuery(new URL(request.url));
  const items = await listPosts(getDb(), query);
  return json({ posts: items, limit: query.limit, offset: query.offset });
});

/** POST /api/posts — creates a draft unless `status` says otherwise. */
export const POST = handle(async (request: NextRequest) => {
  const body = createPostSchema.parse(await readJsonBody(request));
  const db = getDb();
  const post = await createPost(db, body);

  if (affectsPublicOutput(post.status)) {
    await revalidatePublicPages(db, {
      slugs: [post.slug],
      tagSlugs: post.tags.map((tag) => tag.slug),
      seriesIds: [post.series_id],
    });
  }
  return json({ post }, 201);
});
