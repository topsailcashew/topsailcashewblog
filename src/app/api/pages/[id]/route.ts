import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { handle, json, notFound, readJsonBody } from "@/lib/http";
import { deletePage, getPageById, updatePage } from "@/lib/pages";
import { affectsPublicOutput, revalidatePublicPages } from "@/lib/revalidate";
import { updatePageSchema, uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function pageId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

/** GET /api/pages/:id */
export const GET = handle(async (_request: NextRequest, context: RouteContext) => {
  const page = await getPageById(getDb(), await pageId(context));
  if (!page) throw notFound("Page");
  return json({ page });
});

/** PATCH /api/pages/:id */
export const PATCH = handle(async (request: NextRequest, context: RouteContext) => {
  const id = await pageId(context);
  const body = updatePageSchema.parse(await readJsonBody(request));
  const db = getDb();

  const before = await getPageById(db, id);
  if (!before) throw notFound("Page");

  const { page, previousSlug } = await updatePage(db, id, body);
  if (affectsPublicOutput(page.status, before.status)) {
    await revalidatePublicPages(db, { slugs: [page.slug, previousSlug] });
  }
  return json({ page });
});

/** DELETE /api/pages/:id */
export const DELETE = handle(async (_request: NextRequest, context: RouteContext) => {
  const id = await pageId(context);
  const db = getDb();

  // Read it first: once it is gone we cannot know which URL it occupied.
  const existing = await getPageById(db, id);
  await deletePage(db, id);
  if (existing) await revalidatePublicPages(db, { slugs: [existing.slug] });

  return new Response(null, { status: 204 });
});
