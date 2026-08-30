import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { handle, json, notFound, readJsonBody } from "@/lib/http";
import { deletePost, getPostById, updatePost } from "@/lib/posts";
import { updatePostSchema, uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Validate the id before anything touches the database, so a malformed id is
 * a 422 rather than whatever the connection happens to do first.
 */
async function postId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

/** GET /api/posts/:id */
export const GET = handle(async (_request: NextRequest, context: RouteContext) => {
  const id = await postId(context);
  const post = await getPostById(getDb(), id);
  if (!post) throw notFound("Post");
  return json({ post });
});

/** PATCH /api/posts/:id — title, content, excerpt, cover, tags, status, slug. */
export const PATCH = handle(async (request: NextRequest, context: RouteContext) => {
  const id = await postId(context);
  const body = updatePostSchema.parse(await readJsonBody(request));
  const post = await updatePost(getDb(), id, body);
  return json({ post });
});

/** DELETE /api/posts/:id */
export const DELETE = handle(async (_request: NextRequest, context: RouteContext) => {
  const id = await postId(context);
  await deletePost(getDb(), id);
  return new Response(null, { status: 204 });
});
