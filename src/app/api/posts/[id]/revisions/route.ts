import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { handle, json, notFound, readJsonBody } from "@/lib/http";
import { getPostById, updatePost } from "@/lib/posts";
import { getRevision, listRevisions, snapshotPost } from "@/lib/revisions";
import { affectsPublicOutput, revalidatePublicPages } from "@/lib/revalidate";
import { renderTiptapHtml } from "@/lib/tiptap-html";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const restoreSchema = z.object({ revision_id: z.uuid() });

async function postId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

/** GET /api/posts/:id/revisions — the snapshot list for the restore panel. */
export const GET = handle(async (_request: NextRequest, context: RouteContext) => {
  const id = await postId(context);
  return json({ revisions: await listRevisions(getDb(), id) });
});

/**
 * POST /api/posts/:id/revisions — restore one snapshot over the live post.
 *
 * The current text is snapshotted first, so restoring is itself undoable.
 */
export const POST = handle(async (request: NextRequest, context: RouteContext) => {
  const id = await postId(context);
  const { revision_id } = restoreSchema.parse(await readJsonBody(request));
  const db = getDb();

  const before = await getPostById(db, id);
  if (!before) throw notFound("Post");

  const revision = await getRevision(db, revision_id);
  // Checking ownership as well as existence: a valid revision id belonging to
  // a different post must not be writable into this one.
  if (!revision || revision.postId !== id) throw notFound("Revision");

  await snapshotPost(db, id, "restore");

  const { post, previous } = await updatePost(db, id, {
    title: revision.title,
    excerpt: revision.excerpt,
    content_json: revision.contentJson,
    content_html: renderTiptapHtml(revision.contentJson),
  });

  if (affectsPublicOutput(post.status, previous.status)) {
    await revalidatePublicPages(db, {
      slugs: [post.slug],
      tagSlugs: post.tags.map((tag) => tag.slug),
      seriesIds: [post.series_id],
    });
  }

  return json({ post });
});
