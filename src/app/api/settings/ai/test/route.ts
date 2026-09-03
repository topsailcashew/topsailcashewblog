import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { aiConfigured, loadAiSettings, resolveGeminiKey } from "@/lib/ai/config";
import { generateJson, toApiError } from "@/lib/ai/gemini";
import { ApiError, handle, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/ai/test — proves the key before anything expensive.
 *
 * The same reasoning as the SMTP test: discovering a bad key halfway through
 * a cover generation costs real money and twenty seconds, and discovering it
 * from one cheap call costs neither.
 */
export const POST = handle(async () => {
  const secret = getSessionSecret();
  if (!secret) throw new ApiError(500, "Server is missing SESSION_SECRET");

  const db = getDb();
  const ai = await loadAiSettings(db);
  if (!aiConfigured(ai)) throw new ApiError(422, "Add an API key before testing");

  const key = await resolveGeminiKey(ai, secret);
  if (!key) {
    throw new ApiError(
      422,
      "The stored key could not be decrypted. SESSION_SECRET may have been rotated — enter the key again.",
    );
  }

  const started = Date.now();
  try {
    const result = await generateJson({
      key,
      model: ai.textModel,
      systemInstruction: "Answer with the requested JSON and nothing else.",
      prompt: 'Reply with {"ok": true}.',
      schema: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } }, required: ["ok"] },
      parse: (value) => value as { ok: boolean },
      maxOutputTokens: 32,
      thinkingBudget: 0,
      timeoutMs: 15_000,
    });
    return json({
      ok: Boolean(result?.ok),
      model: ai.textModel,
      latency_ms: Date.now() - started,
    });
  } catch (cause) {
    throw toApiError(cause);
  }
});
