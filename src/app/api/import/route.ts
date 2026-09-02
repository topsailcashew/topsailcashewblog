import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { handle, json, readJsonBody } from "@/lib/http";
import { countImportedPosts, importDocument } from "@/lib/import-documents";

export const dynamic = "force-dynamic";

/**
 * How much is accepted in one request.
 *
 * The browser sends documents in small batches rather than one enormous body:
 * Next buffers the whole body for the proxy, and a folder of long essays would
 * otherwise be rejected as oversized with a message that explains nothing. The
 * client keeps its own overall cap and shows progress between batches.
 */
const MAX_DOCUMENTS_PER_REQUEST = 10;
const MAX_CHARS_PER_DOCUMENT = 500_000;

const importSchema = z.object({
  documents: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(1024),
        content: z.string().max(MAX_CHARS_PER_DOCUMENT),
      }),
    )
    .min(1)
    .max(MAX_DOCUMENTS_PER_REQUEST),
});

/**
 * POST /api/import — file dropped documents as drafts.
 *
 * Creates drafts only, so this route publishes nothing and cannot change what
 * a reader sees. There is deliberately no cache invalidation here.
 */
export const POST = handle(async (request: NextRequest) => {
  const { documents } = importSchema.parse(await readJsonBody(request));
  const db = getDb();

  const items = [];
  for (const document of documents) {
    items.push(await importDocument(db, document));
  }

  return json({ items });
});

/** GET /api/import — how many posts came in this way. */
export const GET = handle(async () => {
  return json({ imported_posts: await countImportedPosts(getDb()) });
});
