import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { handle, json, readJsonBody } from "@/lib/http";
import { createRedirect, listRedirects } from "@/lib/redirects";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  from_path: z.string().trim().min(1).max(2048),
  to_path: z.string().trim().min(1).max(2048),
});

/** GET /api/redirects */
export const GET = handle(async () => {
  return json({ redirects: await listRedirects(getDb()) });
});

/** POST /api/redirects — a hand-written rule. */
export const POST = handle(async (request: NextRequest) => {
  const body = createSchema.parse(await readJsonBody(request));
  const redirect = await createRedirect(getDb(), body.from_path, body.to_path);
  return json({ redirect }, 201);
});
