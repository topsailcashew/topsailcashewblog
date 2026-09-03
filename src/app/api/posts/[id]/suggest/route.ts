import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { aiReady, loadAiSettings, resolveGeminiKey } from "@/lib/ai/config";
import { toApiError } from "@/lib/ai/gemini";
import { suggestForPost } from "@/lib/ai/suggest";
import { toBlocks } from "@/lib/blocks";
import { ApiError, handle, json, notFound } from "@/lib/http";
import { getPostById } from "@/lib/posts";
import { listSeries } from "@/lib/series";
import { listTagVocabulary } from "@/lib/tags";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/suggest — titles, excerpt, tags, series, quotes, in one call.
 *
 * The existing tag and series vocabulary goes into the prompt *and* into the
 * response schema as enum constraints, then gets re-checked on the way back:
 * an enum lowers the error rate and guarantees nothing.
 */
export const POST = handle(async (_request: NextRequest, context: RouteContext) => {
  const secret = getSessionSecret();
  if (!secret) throw new ApiError(500, "Server is missing SESSION_SECRET");

  const { id: raw } = await context.params;
  const id = uuidSchema.parse(raw);
  const db = getDb();

  const ai = await loadAiSettings(db);
  if (!aiReady(ai)) throw new ApiError(422, "Add a Gemini API key in Settings first");
  const key = await resolveGeminiKey(ai, secret);
  if (!key) throw new ApiError(422, "No Gemini API key is configured");

  const post = await getPostById(db, id);
  if (!post) throw notFound("Post");

  const blocks = toBlocks(post.content_json);
  if (blocks.length === 0) throw new ApiError(422, "There is nothing here to file yet");

  const [vocabulary, allSeries] = await Promise.all([
    listTagVocabulary(db),
    listSeries(db),
  ]);

  try {
    const suggestions = await suggestForPost({
      key,
      model: ai.textModel,
      title: post.title,
      blocks,
      vocabulary,
      series: allSeries.map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        title: entry.title,
      })),
      currentTags: post.tags.map((tag) => tag.name),
      // A deliberate choice should not be overwritten by a guess.
      hasSeries: post.series_id !== null,
    });
    return json({ suggestions });
  } catch (cause) {
    throw toApiError(cause);
  }
});
