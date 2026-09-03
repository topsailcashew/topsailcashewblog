import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { aiConfigured, loadAiSettings, resolveGeminiKey } from "@/lib/ai/config";
import { closestModels, generateJson, listModels, toApiError } from "@/lib/ai/gemini";
import { ApiError, handle, json, readJsonBody } from "@/lib/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/ai/test — proves the key before anything expensive.
 *
 * The same reasoning as the SMTP test: discovering a bad key halfway through
 * a cover generation costs real money and twenty seconds, and discovering it
 * from one cheap call costs neither.
 */
const bodySchema = z
  .object({
    text_model: z.string().trim().optional(),
    image_model: z.string().trim().optional(),
  })
  .partial();

export const POST = handle(async (request: NextRequest) => {
  const secret = getSessionSecret();
  if (!secret) throw new ApiError(500, "Server is missing SESSION_SECRET");

  const db = getDb();
  const stored = await loadAiSettings(db);

  /*
    Test what is on screen, not what is in the database.

    The button sits directly under two editable fields and used to ignore
    both: it read the stored ids, so typing a new model and pressing Test
    reported a failure about the *old* one, naming an id that was no longer
    anywhere on the page. Unsaved values are the whole reason to press it.
  */
  const supplied = bodySchema.parse(await readJsonBody(request).catch(() => ({})));
  const ai = {
    ...stored,
    textModel: supplied.text_model || stored.textModel,
    imageModel: supplied.image_model || stored.imageModel,
  };
  const unsaved =
    ai.textModel !== stored.textModel || ai.imageModel !== stored.imageModel;
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
  let listingFailure: string | null = null;
  const available = await listModels({ key, timeoutMs: 15_000 }).catch((cause: unknown) => {
    listingFailure = cause instanceof Error ? cause.message : "the model list was unreadable";
    return null;
  });
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
      image_model: ai.imageModel,
      unsaved,
      latency_ms: Date.now() - started,
    });
  } catch (cause) {
    const failure = toApiError(cause);
    /*
      Reaching a "no such model" here means the check above could not run.
      Saying why beats repeating an error whose only advice is to change an id
      to one the author still has no way of discovering.
    */
    if (listingFailure && /no model called/i.test(failure.message)) {
      throw new ApiError(
        failure.status,
        `${failure.message} Could not list the alternatives either — ${listingFailure}`,
      );
    }
    throw failure;
  }
});
