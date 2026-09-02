import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { handle, json, notFound, readJsonBody } from "@/lib/http";
import {
  deleteMedia,
  findMediaUsage,
  getMediaById,
  serializeMedia,
  setMediaAltText,
} from "@/lib/media";
import { getMediaBucket } from "@/lib/r2";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  alt_text: z.string().max(500).nullable(),
});

async function mediaId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

/** GET /api/media/:id — the item plus where it is used. */
export const GET = handle(async (_request: NextRequest, context: RouteContext) => {
  const id = await mediaId(context);
  const db = getDb();

  const row = await getMediaById(db, id);
  if (!row) throw notFound("Media");

  return json({
    media: serializeMedia(row),
    usage: await findMediaUsage(db, row.url),
  });
});

/** PATCH /api/media/:id — alt text is the only editable field. */
export const PATCH = handle(async (request: NextRequest, context: RouteContext) => {
  const id = await mediaId(context);
  const { alt_text } = patchSchema.parse(await readJsonBody(request));
  return json({ media: await setMediaAltText(getDb(), id, alt_text) });
});

/**
 * DELETE /api/media/:id
 *
 * Refuses while the image is still referenced, unless `?force=1`. Deleting a
 * file out from under a published post is not something to do on a single
 * confirm dialog, and the caller has the usage list to show instead.
 */
export const DELETE = handle(async (request: NextRequest, context: RouteContext) => {
  const id = await mediaId(context);
  const db = getDb();
  const force = new URL(request.url).searchParams.get("force") === "1";

  const row = await getMediaById(db, id);
  if (!row) throw notFound("Media");

  if (!force) {
    const usage = await findMediaUsage(db, row.url);
    if (usage.length > 0) {
      return json(
        {
          error: `Still used in ${usage.length} place${usage.length === 1 ? "" : "s"}`,
          usage,
        },
        409,
      );
    }
  }

  await deleteMedia(db, await getMediaBucket(), id);
  return new Response(null, { status: 204 });
});
