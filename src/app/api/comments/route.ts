import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { posts } from "@/db/schema";
import { getSessionSecret } from "@/lib/auth";
import {
  COMMENT_STATUSES,
  countRecentFrom,
  listForModeration,
  rateLimitPerHour,
  submitComment,
  type CommentStatus,
} from "@/lib/comments";
import { ApiError, handle, json, readJsonBody } from "@/lib/http";
import { hashClientAddress } from "@/lib/session";
import { HONEYPOT_FIELD, submitCommentSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * The address Cloudflare saw. `cf-connecting-ip` is set by the edge and cannot
 * be spoofed by the client; `x-forwarded-for` is only a local-development
 * fallback and is explicitly not trusted in production.
 */
function clientAddress(request: NextRequest): string | null {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct) return direct;
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? (forwarded.split(",")[0]?.trim() ?? null) : null;
}

/**
 * POST /api/comments — public. Anyone may submit; nobody may publish.
 *
 * Every submission is stored as `pending` and stays invisible until it is
 * approved in /admin/comments.
 */
export const POST = handle(async (request: NextRequest) => {
  const body = submitCommentSchema.parse(await readJsonBody(request));

  // Honeypot: a hidden field only an automated client fills in. Accepted with
  // a normal-looking response so a bot cannot tell it was caught, but nothing
  // is written.
  if (body[HONEYPOT_FIELD]) {
    return json({ status: "pending" }, 202);
  }

  const db = getDb();

  const [post] = await db
    .select({ id: posts.id, status: posts.status })
    .from(posts)
    .where(eq(posts.id, body.post_id))
    .limit(1);
  // Commenting on a draft would leak that the draft exists.
  if (!post || post.status !== "published") {
    throw new ApiError(404, "Post not found");
  }

  const secret = getSessionSecret();
  const address = clientAddress(request);
  const ipHash =
    secret && address ? await hashClientAddress(address, secret) : null;

  if (ipHash) {
    const recent = await countRecentFrom(db, ipHash);
    if (recent >= rateLimitPerHour()) {
      throw new ApiError(
        429,
        "That is a lot of comments in one hour. Try again later.",
      );
    }
  }

  await submitComment(db, {
    postId: body.post_id,
    parentId: body.parent_id ?? null,
    authorName: body.author_name,
    authorEmail: body.author_email,
    body: body.body,
    ipHash,
  });

  return json({ status: "pending" }, 202);
});

/** GET /api/comments?status= — the moderation queue. Requires a session. */
export const GET = handle(async (request: NextRequest) => {
  const raw = new URL(request.url).searchParams.get("status");
  const status = COMMENT_STATUSES.includes(raw as CommentStatus)
    ? (raw as CommentStatus)
    : undefined;
  return json({ comments: await listForModeration(getDb(), status) });
});
