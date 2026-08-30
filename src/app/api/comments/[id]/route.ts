import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { replyAsAuthor, setCommentStatus } from "@/lib/comments";
import { handle, json, readJsonBody } from "@/lib/http";
import { revalidatePublicPages } from "@/lib/revalidate";
import { siteConfig } from "@/lib/site";
import { authorReplySchema, moderateCommentSchema, uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function commentId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

/** PATCH /api/comments/:id — approve, reject, or mark as spam. */
export const PATCH = handle(async (request: NextRequest, context: RouteContext) => {
  const id = await commentId(context);
  const { status } = moderateCommentSchema.parse(await readJsonBody(request));

  const db = getDb();
  const comment = await setCommentStatus(db, id, status);

  // The thread is rendered into the cached post page, so a moderation decision
  // has to drop that page for the change to be visible.
  if (comment.post) {
    await revalidatePublicPages(db, { slugs: [comment.post.slug] });
  }
  return json({ comment });
});

/** POST /api/comments/:id — reply as the author. Auto-approved and badged. */
export const POST = handle(async (request: NextRequest, context: RouteContext) => {
  const parentId = await commentId(context);
  const { body } = authorReplySchema.parse(await readJsonBody(request));

  const db = getDb();
  const comment = await replyAsAuthor(db, {
    parentId,
    authorName: siteConfig.name,
    authorEmail: process.env.ADMIN_EMAIL ?? "",
    body,
  });

  if (comment.post) {
    await revalidatePublicPages(db, { slugs: [comment.post.slug] });
  }
  return json({ comment }, 201);
});
