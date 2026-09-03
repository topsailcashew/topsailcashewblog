import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { analyseDraft, analysisIsEmpty } from "@/lib/ai/analysis";
import { loadAiSettings, resolveGeminiKey, aiReady } from "@/lib/ai/config";
import { toApiError } from "@/lib/ai/gemini";
import { toBlocks } from "@/lib/blocks";
import { ApiError, handle, json, notFound } from "@/lib/http";
import { getPostById } from "@/lib/posts";
import { measure } from "@/lib/prose-metrics";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/analysis — a developmental read of the draft.
 *
 * The countable things are measured here and handed to the model as settled
 * facts, so it spends its output on judgement rather than re-deriving
 * statistics it would get wrong. See ANALYSIS_RULES rule 3.
 */
export const POST = handle(async (_request: NextRequest, context: RouteContext) => {
  const secret = getSessionSecret();
  if (!secret) throw new ApiError(500, "Server is missing SESSION_SECRET");

  const { id: raw } = await context.params;
  const id = uuidSchema.parse(raw);
  const db = getDb();

  const ai = await loadAiSettings(db);
  if (!aiReady(ai)) {
    throw new ApiError(422, "Add a Gemini API key in Settings before asking for a read");
  }
  const key = await resolveGeminiKey(ai, secret);
  if (!key) throw new ApiError(422, "No Gemini API key is configured");

  const post = await getPostById(db, id);
  if (!post) throw notFound("Post");

  const blocks = toBlocks(post.content_json);
  const metrics = measure(blocks);
  if (metrics.words < 50) {
    throw new ApiError(422, "There is not enough here to read yet");
  }

  let analysis;
  try {
    analysis = await analyseDraft({
      key,
      model: ai.textModel,
      title: post.title,
      blocks,
      metrics,
    });
  } catch (cause) {
    throw toApiError(cause);
  }

  /*
    An empty findings list reads as "your draft is flawless", which is the most
    damaging thing this feature could say. If everything dropped in
    verification, that is a failure to report rather than a result to render.
  */
  if (analysisIsEmpty(analysis)) {
    throw new ApiError(502, "Gemini returned nothing usable — try again");
  }

  return json({ analysis, measured: metrics.words });
});
