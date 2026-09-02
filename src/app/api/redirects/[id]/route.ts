import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { handle } from "@/lib/http";
import { deleteRedirect } from "@/lib/redirects";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** DELETE /api/redirects/:id */
export const DELETE = handle(async (_request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  await deleteRedirect(getDb(), uuidSchema.parse(id));
  return new Response(null, { status: 204 });
});
