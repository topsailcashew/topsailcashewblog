import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { ApiError, handle, json, notFound } from "@/lib/http";
import { getPostById } from "@/lib/posts";
import { createPreviewToken, PREVIEW_TTL_SECONDS } from "@/lib/preview";
import { absoluteUrl } from "@/lib/site";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/preview — mint a share link for an unpublished draft.
 *
 * Behind the admin session like every other write. The link it returns is a
 * read capability for this one post and expires on its own.
 */
export const POST = handle(async (_request: NextRequest, context: RouteContext) => {
  const { id: raw } = await context.params;
  const id = uuidSchema.parse(raw);

  const secret = getSessionSecret();
  if (!secret) throw new ApiError(500, "Server is missing SESSION_SECRET");

  const post = await getPostById(getDb(), id);
  if (!post) throw notFound("Post");

  const token = await createPreviewToken(post.id, secret);
  return json({
    url: absoluteUrl(`/preview/${token}`),
    expires_in: PREVIEW_TTL_SECONDS,
  });
});
