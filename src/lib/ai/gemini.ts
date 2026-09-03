import { ApiError } from "../http";

/**
 * The Gemini REST API, over plain `fetch`.
 *
 * No SDK. `@google/genai` is a couple of hundred kilobytes against a Worker
 * budget of three megabytes, and the request is one JSON object — the same
 * reasoning that produced the hand-written SMTP client in
 * `src/lib/email/smtp.ts`, which this file copies the shape of: an injectable
 * transport, its own error type, and every failure mapped to a sentence the
 * author can act on.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiTransport = (url: string, init: RequestInit) => Promise<Response>;

export type GeminiFailure =
  | "auth"
  | "quota"
  | "blocked"
  | "timeout"
  | "malformed"
  | "unavailable"
  | "model_not_found"
  | "unknown";

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly reason: GeminiFailure,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/** A `responseSchema`, in the subset of OpenAPI that Gemini accepts. */
export type GeminiSchema = {
  type: "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN";
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  propertyOrdering?: string[];
  enum?: string[];
  description?: string;
  maxItems?: number;
  minItems?: number;
  nullable?: boolean;
};

/*
  Safety at its most permissive.

  Essays about grief, illness, violence and politics are ordinary writing, and
  the default thresholds will refuse to read a legitimate draft. A blocked
  draft is also the failure people report as "the button does nothing", so it
  gets its own error message rather than an empty panel.
*/
const SAFETY = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

const TEXT_TIMEOUT_MS = 30_000;
/*
  Under Cloudflare's ~100 s edge limit, which returns a 524 HTML error page
  rather than a JSON error the panel could render.
*/
const IMAGE_TIMEOUT_MS = 75_000;

type Candidate = {
  content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] };
  finishReason?: string;
};

type GeminiResponse = {
  candidates?: Candidate[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; status?: string; message?: string };
};

/**
 * One structured-output call.
 *
 * `parse` is a Zod schema's `.parse`: `responseSchema` is a request, not a
 * contract, and Gemini will occasionally return a field as a string where an
 * enum was asked for. The schema lowers the error rate; the parse is what
 * enforces it.
 */
export async function generateJson<T>(options: {
  key: string;
  model: string;
  systemInstruction: string;
  prompt: string;
  schema: GeminiSchema;
  parse: (raw: unknown) => T;
  temperature?: number;
  maxOutputTokens?: number;
  /** 0 disables thinking, which is right for easy tasks where latency shows. */
  thinkingBudget?: number;
  timeoutMs?: number;
  transport?: GeminiTransport;
}): Promise<T> {
  const body = {
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: options.prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxOutputTokens ?? 2048,
      responseMimeType: "application/json",
      responseSchema: options.schema,
      ...(options.thinkingBudget !== undefined
        ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } }
        : {}),
    },
    safetySettings: SAFETY,
  };

  const response = await call(options.model, body, {
    key: options.key,
    timeoutMs: options.timeoutMs ?? TEXT_TIMEOUT_MS,
    transport: options.transport,
  });

  const text = textOf(response);
  if (text === null) {
    throw new GeminiError("Gemini returned no text to parse", "malformed");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GeminiError("Gemini returned something that was not JSON", "malformed");
  }

  try {
    return options.parse(raw);
  } catch {
    throw new GeminiError(
      "Gemini returned something that was not the requested shape",
      "malformed",
    );
  }
}

export type GeneratedImage = { mimeType: string; dataBase64: string };

export async function generateImage(options: {
  key: string;
  model: string;
  prompt: string;
  aspectRatio?: string;
  timeoutMs?: number;
  transport?: GeminiTransport;
}): Promise<GeneratedImage> {
  const body = {
    contents: [{ role: "user", parts: [{ text: options.prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      ...(options.aspectRatio ? { imageConfig: { aspectRatio: options.aspectRatio } } : {}),
    },
    safetySettings: SAFETY,
  };

  const response = await call(options.model, body, {
    key: options.key,
    timeoutMs: options.timeoutMs ?? IMAGE_TIMEOUT_MS,
    transport: options.transport,
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((part) => part?.inlineData?.data);

  if (!image?.inlineData?.data) {
    /*
      When the image model declines it usually explains why in a text part, and
      that sentence is the most useful error message available — far better
      than "no image returned".
    */
    const said = parts.find((part) => typeof part?.text === "string")?.text;
    throw new GeminiError(said?.trim() || "Gemini returned no image", "blocked");
  }

  return {
    mimeType: image.inlineData.mimeType ?? "image/png",
    dataBase64: image.inlineData.data,
  };
}

/* --- model discovery ------------------------------------------------------ */

export type GeminiModel = {
  /** The bare id, as it goes in Settings — `models/` stripped. */
  id: string;
  displayName?: string;
  methods: string[];
};

type ModelsResponse = {
  models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[];
  nextPageToken?: string;
};

/**
 * Every model this key can call.
 *
 * "No model called X" is a true statement that leaves the author nowhere to
 * go, because the fix is an id they do not have. Google will hand over the
 * list, and which ids exist depends on the key — the free tier, a billed
 * project and a restricted key all see different sets, so there is no constant
 * this could be replaced with.
 *
 * Filtered to `generateContent`, which is the only method anything here calls.
 */
export async function listModels(options: {
  key: string;
  timeoutMs?: number;
  transport?: GeminiTransport;
}): Promise<GeminiModel[]> {
  const found: GeminiModel[] = [];
  let pageToken: string | undefined;

  // Paged, but bounded: a key with more than a few hundred models is not a
  // thing, and an unbounded loop against a remote cursor is a hang.
  for (let page = 0; page < 5; page += 1) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await send(
      url.toString(),
      { method: "GET" },
      { key: options.key, timeoutMs: options.timeoutMs ?? 15_000, transport: options.transport },
    );

    const parsed = (await response.json().catch(() => null)) as ModelsResponse | null;
    if (!response.ok) throw httpFailure(response.status, parsed as GeminiResponse | null, "models");
    if (!parsed) throw new GeminiError("Gemini returned an unreadable model list", "malformed");

    for (const model of parsed.models ?? []) {
      if (!model.name) continue;
      /*
        A model is dropped only when it *says* it cannot generate. Filtering on
        `?? []` instead threw away every model whenever the field was absent,
        which newer API versions leave off — the list came back empty, the
        check upstream was skipped as "no list available", and the caller got
        the same unhelpful 404 this function exists to replace. Absence of the
        field is not evidence of absence of the capability.
      */
      const methods = model.supportedGenerationMethods;
      if (methods && !methods.includes("generateContent")) continue;
      found.push({
        id: model.name.replace(/^models\//, ""),
        displayName: model.displayName,
        methods: methods ?? [],
      });
    }

    pageToken = parsed.nextPageToken;
    if (!pageToken) break;
  }

  return found;
}

/**
 * The ids worth showing someone who typed one that does not exist.
 *
 * Ranked by shared prefix with what they typed, so a moved id surfaces its own
 * replacement first — `gemini-3.8-flash` puts `gemini-3.8-flash-002` at the
 * top rather than burying it under an alphabetical list.
 */
export function closestModels(wanted: string, available: GeminiModel[], limit = 6): string[] {
  const ids = available.map((model) => model.id);
  const shared = (candidate: string) => {
    let index = 0;
    while (index < wanted.length && index < candidate.length && wanted[index] === candidate[index]) {
      index += 1;
    }
    return index;
  };
  return [...ids]
    .sort((a, b) => shared(b) - shared(a) || a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
}

/* --- transport ------------------------------------------------------------ */

/**
 * One request, with the key attached and every network failure named.
 *
 * The key goes in a header, never `?key=` — a key in a URL lands in every
 * access log and every error report between here and Google.
 */
async function send(
  url: string,
  init: RequestInit,
  options: { key: string; timeoutMs: number; transport?: GeminiTransport },
): Promise<Response> {
  const via = options.transport ?? ((target, request) => fetch(target, request));
  try {
    return await via(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), "x-goog-api-key": options.key },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (cause) {
    if (cause instanceof Error && /abort|timeout/i.test(cause.name + cause.message)) {
      throw new GeminiError(
        `Gemini did not answer within ${Math.round(options.timeoutMs / 1000)} seconds`,
        "timeout",
      );
    }
    throw new GeminiError(
      cause instanceof Error ? cause.message : "Could not reach Gemini",
      "unavailable",
    );
  }
}

async function call(
  model: string,
  body: unknown,
  options: { key: string; timeoutMs: number; transport?: GeminiTransport },
): Promise<GeminiResponse> {
  const response = await send(
    `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );

  const parsed = (await response.json().catch(() => null)) as GeminiResponse | null;
  if (!response.ok) throw httpFailure(response.status, parsed, model);
  if (!parsed) throw new GeminiError("Gemini returned an unreadable body", "malformed");

  const blocked = parsed.promptFeedback?.blockReason;
  if (blocked) {
    throw new GeminiError(
      `Gemini declined to read this draft (${blocked}). Safety thresholds are already at their most permissive setting.`,
      "blocked",
    );
  }

  const finish = parsed.candidates?.[0]?.finishReason;
  if (finish && /SAFETY|PROHIBITED|RECITATION|BLOCKLIST/i.test(finish)) {
    throw new GeminiError(`Gemini stopped early (${finish})`, "blocked");
  }
  if (finish === "MAX_TOKENS") {
    /*
      With thinking enabled and the output cap too low, a 2.5 model returns
      MAX_TOKENS with *empty* parts — which naive code turns into
      `JSON.parse(undefined)` three frames away from the cause.
    */
    throw new GeminiError(
      "Gemini ran out of room before finishing — the draft may be too long",
      "malformed",
    );
  }

  return parsed;
}

function httpFailure(status: number, body: GeminiResponse | null, model: string): GeminiError {
  const detail = body?.error?.message;
  const code = body?.error?.status;

  if (status === 400 && code === "FAILED_PRECONDITION") {
    return new GeminiError(
      "Gemini needs billing enabled on this key, or is not available in this region.",
      "auth",
      status,
    );
  }
  /*
    A rejected key comes back as 400 INVALID_ARGUMENT, not 401 — found by
    pointing the real transport at the real endpoint with a bad key. Without
    this the generic 400 branch below tells the author their *prompt* is
    broken, which is both wrong and unactionable.
  */
  if (status === 400 && /api[_ ]key not valid|API_KEY_INVALID/i.test(detail ?? "")) {
    return new GeminiError(
      "Gemini refused the API key. Check it in Settings — a key from Google AI Studio starts with \"AIza\".",
      "auth",
      status,
    );
  }
  if (status === 400) {
    return new GeminiError(
      `Gemini rejected the request${detail ? `: ${detail}` : ""}. This is a bug in the prompt, not in your draft.`,
      "malformed",
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new GeminiError(
      "Gemini refused the API key. Check it in Settings.",
      "auth",
      status,
    );
  }
  if (status === 404) {
    return new GeminiError(
      `No model called "${model}". Model ids move — change it in Settings.`,
      "model_not_found",
      status,
    );
  }
  if (status === 429) {
    return new GeminiError(
      "Gemini quota exhausted. Free-tier limits reset each minute; try again shortly.",
      "quota",
      status,
    );
  }
  if (status >= 500) {
    return new GeminiError(
      "Gemini is unavailable. This is usually transient.",
      "unavailable",
      status,
    );
  }
  return new GeminiError(detail ?? `Gemini failed (${status})`, "unknown", status);
}

/** All the text parts, concatenated. */
function textOf(response: GeminiResponse): string | null {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  return text === "" ? null : text;
}

/**
 * Maps a Gemini failure onto the HTTP status a route should return.
 *
 * `handle()` catches `ApiError` and turns anything else into a 500 "Internal
 * server error" — the one outcome that tells the author nothing. Every route
 * that calls this module wraps it and rethrows through here.
 */
export function toApiError(cause: unknown): ApiError {
  if (!(cause instanceof GeminiError)) {
    return new ApiError(502, cause instanceof Error ? cause.message : "The model call failed");
  }
  switch (cause.reason) {
    case "quota":
      return new ApiError(429, cause.message);
    case "blocked":
      return new ApiError(422, cause.message);
    case "timeout":
      return new ApiError(504, cause.message);
    default:
      return new ApiError(502, cause.message);
  }
}
