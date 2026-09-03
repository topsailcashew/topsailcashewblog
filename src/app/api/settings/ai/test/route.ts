import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { aiConfigured, loadAiSettings, resolveGeminiKey } from "@/lib/ai/config";
import { closestModels, generateJson, listModels, toApiError } from "@/lib/ai/gemini";
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

  /*
    Check both ids against what the key can actually reach, before spending a
    generation on it.

    The test used to call the text model and nothing else, so a wrong image id
    stayed hidden until a cover generation had cost real money and seventy-five
    seconds — and a wrong text id produced "no model called X", which is true,
    unhelpful, and leaves the author guessing at an id they do not have. Which
    ids exist depends on the key, so asking is the only way to know.

    A listing failure is not fatal: an older or restricted key that cannot list
    models can still generate with them, and refusing to test a working setup
    because a diagnostic is unavailable would be worse than the bug.
  */
  const available = await listModels({ key, timeoutMs: 15_000 }).catch(() => null);
  if (available && available.length > 0) {
    const missing = (
      [
        ["Text model", ai.textModel],
        ["Image model", ai.imageModel],
      ] as const
    ).filter(([, id]) => id !== "" && !available.some((model) => model.id === id));

    if (missing.length > 0) {
      const detail = missing
        .map(
          ([field, id]) =>
            `${field} "${id}" does not exist. Try: ${closestModels(id, available).join(", ")}`,
        )
        .join(" — ");
      throw new ApiError(422, `This key reaches ${available.length} models. ${detail}`);
    }
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
