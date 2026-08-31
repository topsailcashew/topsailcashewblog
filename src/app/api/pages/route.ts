import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { handle, json, readJsonBody } from "@/lib/http";
import { createPage, listPages } from "@/lib/pages";
import { revalidatePublicPages } from "@/lib/revalidate";
import { createPageSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** GET /api/pages */
export const GET = handle(async () => {
  return json({ pages: await listPages(getDb()) });
});

/** POST /api/pages */
export const POST = handle(async (request: NextRequest) => {
  const body = createPageSchema.parse(await readJsonBody(request));
  const db = getDb();
  const page = await createPage(db, body);
  if (page.status === "published") {
    await revalidatePublicPages(db, { slugs: [page.slug] });
  }
  return json({ page }, 201);
});
