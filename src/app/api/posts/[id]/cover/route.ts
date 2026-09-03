import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { aiReady, loadAiSettings, resolveGeminiKey } from "@/lib/ai/config";
import {
  generateCoverBrief,
  generateCoverImage,
  withinUploadLimit,
} from "@/lib/ai/cover";
import { toApiError } from "@/lib/ai/gemini";
import { toBlocks } from "@/lib/blocks";
import { ApiError, handle, json, notFound, readJsonBody } from "@/lib/http";
import { getPostById } from "@/lib/posts";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { generateCoverSchema, uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/cover — generates a cover, and returns the bytes.
 *
 * The image is handed back as base64 rather than written to R2 here, for three
 * reasons. A rejected generation then leaves no orphaned object and no `media`
 * row for `findMediaUsage` to report as used by nothing. The Worker skips a
 * two-megabyte `atob` on a 10 ms CPU budget. And it matches how this codebase
 * already does heavy byte work in the browser — ZIP inflate, BlurHash — so the
 * accepted cover also picks up a blur placeholder like every other upload.
 */
export const POST = handle(async (request: NextRequest, context: RouteContext) => {
  const secret = getSessionSecret();
  if (!secret) throw new ApiError(500, "Server is missing SESSION_SECRET");

  const { id: raw } = await context.params;
  const id = uuidSchema.parse(raw);
  const body = generateCoverSchema.parse(await readJsonBody(request).catch(() => ({})));
  const db = getDb();

  const ai = await loadAiSettings(db);
  if (!aiReady(ai)) throw new ApiError(422, "Add a Gemini API key in Settings first");
  const key = await resolveGeminiKey(ai, secret);
  if (!key) throw new ApiError(422, "No Gemini API key is configured");

  const post = await getPostById(db, id);
  if (!post) throw notFound("Post");

  try {
    /*
      A brief supplied by the caller skips stage one entirely — that is what
      makes "try again" with an edited subject cheap, and it is the only way
      the author gets to steer the picture rather than reroll it.
    */
    const brief = body?.brief
      ? {
          subject: body.brief.subject,
          human: body.brief.human ?? "",
          avoid: body.brief.avoid ?? [],
        }
      : await generateCoverBrief({
          key,
          model: ai.textModel,
          title: post.title,
          blocks: toBlocks(post.content_json),
        });

    const image = await generateCoverImage({
      key,
      model: ai.imageModel,
      brief,
      slug: post.slug,
    });

    // A length check on the string, before anything decodes it.
    if (!withinUploadLimit(image.dataBase64, MAX_UPLOAD_BYTES)) {
      throw new ApiError(502, "Gemini returned an image larger than the upload limit");
    }

    return json({ brief, mime_type: image.mimeType, data: image.dataBase64 });
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw toApiError(cause);
  }
});
