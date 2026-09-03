import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  GeminiError,
  generateImage,
  generateJson,
  toApiError,
  type GeminiTransport,
} from "@/lib/ai/gemini";
import { buildCoverPrompt, layoutFor, withinUploadLimit } from "@/lib/ai/cover";
import { buildSuggestSchema, verifySuggestions } from "@/lib/ai/suggest";
import { verifyAnalysis } from "@/lib/ai/analysis";
import type { Block } from "@/lib/blocks";

/** Captures the outgoing request and replies with a scripted response. */
function scripted(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const transport: GeminiTransport = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { transport, seen };
}

/** A well-formed successful response carrying `text` as the model's output. */
const ok = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
});

const trivial = {
  systemInstruction: "rules",
  prompt: "prompt",
  schema: { type: "OBJECT" as const, properties: { ok: { type: "BOOLEAN" as const } } },
  parse: (value: unknown) => z.object({ ok: z.boolean() }).parse(value),
};

describe("the outgoing request", () => {
  it("names the model in the URL and puts the key in a header", async () => {
    const { transport, seen } = scripted(200, ok('{"ok":true}'));
    await generateJson({ ...trivial, key: "secret-key", model: "gemini-2.5-flash", transport });

    const [call] = seen;
    assert.match(call.url, /models\/gemini-2\.5-flash:generateContent$/);
    // A key in the query string lands in every access log on the way.
    assert.ok(!call.url.includes("secret-key"), "the key leaked into the URL");
    assert.equal(
      (call.init.headers as Record<string, string>)["x-goog-api-key"],
      "secret-key",
    );
  });

  it("asks for JSON against a schema, and keeps the rules out of the user turn", async () => {
    const { transport, seen } = scripted(200, ok('{"ok":true}'));
    await generateJson({ ...trivial, key: "k", model: "m", transport });

    const body = JSON.parse(String(seen[0].init.body)) as Record<string, never>;
    const config = body.generationConfig as unknown as Record<string, unknown>;
    assert.equal(config.responseMimeType, "application/json");
    assert.ok(config.responseSchema, "no responseSchema was sent");

    // The rules belong in systemInstruction, not concatenated into the draft —
    // otherwise the draft can argue with them.
    assert.ok(body.systemInstruction, "systemInstruction was not sent as its own field");
    const contents = JSON.stringify(body.contents);
    assert.ok(!contents.includes("rules"), "the system rules leaked into the user turn");
  });

  it("sets safety thresholds permissively", async () => {
    // Essays about grief and illness are ordinary writing; the defaults refuse
    // to read them.
    const { transport, seen } = scripted(200, ok('{"ok":true}'));
    await generateJson({ ...trivial, key: "k", model: "m", transport });

    const body = JSON.parse(String(seen[0].init.body)) as {
      safetySettings: { threshold: string }[];
    };
    assert.equal(body.safetySettings.length, 4);
    assert.ok(body.safetySettings.every((s) => s.threshold === "BLOCK_ONLY_HIGH"));
  });

  it("parses the response through the caller's schema", async () => {
    const { transport } = scripted(200, ok('{"ok":true}'));
    assert.deepEqual(
      await generateJson({ ...trivial, key: "k", model: "m", transport }),
      { ok: true },
    );
  });
});

describe("failure mapping", () => {
  const cases: [number, unknown, string, number][] = [
    [400, { error: { status: "FAILED_PRECONDITION" } }, "auth", 502],
    [400, { error: { message: "bad field" } }, "malformed", 502],
    [401, {}, "auth", 502],
    [403, {}, "auth", 502],
    [404, {}, "model_not_found", 502],
    [429, {}, "quota", 429],
    [500, {}, "unavailable", 502],
    [503, {}, "unavailable", 502],
  ];

  for (const [status, body, reason, apiStatus] of cases) {
    it(`maps HTTP ${status}${(body as { error?: { status?: string } })?.error?.status ? ` ${(body as { error: { status: string } }).error.status}` : ""} to ${reason}`, async () => {
      const { transport } = scripted(status, body);
      await assert.rejects(
        generateJson({ ...trivial, key: "k", model: "m", transport }),
        (error: unknown) => {
          assert.ok(error instanceof GeminiError);
          assert.equal(error.reason, reason);
          assert.equal(toApiError(error).status, apiStatus);
          // Every message has to be something the author can act on.
          assert.ok(error.message.length > 20, `unhelpful message: ${error.message}`);
          return true;
        },
      );
    });
  }

  it("reads a rejected key out of a 400, which is how Google reports it", async () => {
    /*
      Found against the live endpoint: a bad key is 400 INVALID_ARGUMENT, not
      401. Falling through to the generic 400 branch told the author their
      prompt was broken — wrong, and nothing they could act on.
    */
    const { transport } = scripted(400, {
      error: { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." },
    });
    await assert.rejects(
      generateJson({ ...trivial, key: "bad", model: "m", transport }),
      (error: unknown) => {
        assert.ok(error instanceof GeminiError);
        assert.equal(error.reason, "auth");
        assert.match(error.message, /refused the API key/);
        assert.ok(!/bug in the prompt/.test(error.message));
        return true;
      },
    );
  });

  it("reports a blocked prompt as blocked, not as a server error", async () => {
    const { transport } = scripted(200, { promptFeedback: { blockReason: "SAFETY" } });
    await assert.rejects(
      generateJson({ ...trivial, key: "k", model: "m", transport }),
      (error: unknown) => {
        assert.ok(error instanceof GeminiError);
        assert.equal(error.reason, "blocked");
        assert.equal(toApiError(error).status, 422);
        assert.match(error.message, /SAFETY/);
        return true;
      },
    );
  });

  it("names MAX_TOKENS rather than dying on JSON.parse(undefined)", async () => {
    /*
      With thinking on and the output cap low, a 2.5 model returns MAX_TOKENS
      with *empty* parts. Unhandled, that surfaces three frames away as a JSON
      parse error against `undefined`.
    */
    const { transport } = scripted(200, {
      candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
    });
    await assert.rejects(
      generateJson({ ...trivial, key: "k", model: "m", transport }),
      /ran out of room/,
    );
  });

  it("reports unparseable output as malformed", async () => {
    const { transport } = scripted(200, ok("this is not json"));
    await assert.rejects(
      generateJson({ ...trivial, key: "k", model: "m", transport }),
      /not JSON/,
    );
  });

  it("reports a shape the caller's schema rejects", async () => {
    const { transport } = scripted(200, ok('{"ok":"yes"}'));
    await assert.rejects(
      generateJson({ ...trivial, key: "k", model: "m", transport }),
      /not the requested shape/,
    );
  });

  it("turns a non-Gemini error into a 502 rather than a 500", async () => {
    // `handle()` turns anything that is not an ApiError into "Internal server
    // error", which tells the author nothing.
    assert.equal(toApiError(new Error("socket hang up")).status, 502);
  });
});

describe("image generation", () => {
  it("extracts inline data from among mixed parts", async () => {
    const { transport, seen } = scripted(200, {
      candidates: [
        {
          content: {
            parts: [
              { text: "Here is the image." },
              { inlineData: { mimeType: "image/png", data: "QUJD" } },
            ],
          },
        },
      ],
    });

    const image = await generateImage({
      key: "k",
      model: "gemini-2.5-flash-image",
      prompt: "draw",
      aspectRatio: "16:9",
      transport,
    });
    assert.deepEqual(image, { mimeType: "image/png", dataBase64: "QUJD" });

    const body = JSON.parse(String(seen[0].init.body)) as {
      generationConfig: { responseModalities: string[]; imageConfig: { aspectRatio: string } };
    };
    assert.deepEqual(body.generationConfig.responseModalities, ["IMAGE"]);
    assert.equal(body.generationConfig.imageConfig.aspectRatio, "16:9");
  });

  it("uses the model's own sentence when it declines", async () => {
    // When the image model refuses it usually explains why in prose, and that
    // sentence is the most useful error available.
    const { transport } = scripted(200, {
      candidates: [{ content: { parts: [{ text: "I cannot draw that." }] } }],
    });
    await assert.rejects(
      generateImage({ key: "k", model: "m", prompt: "p", transport }),
      /I cannot draw that/,
    );
  });

  it("rejects an oversized payload on length, before any decode", () => {
    const tenMb = 10 * 1024 * 1024;
    assert.equal(withinUploadLimit("A".repeat(1000), tenMb), true);
    assert.equal(withinUploadLimit("A".repeat(tenMb * 2), tenMb), false);
  });
});

describe("the cover prompt", () => {
  const brief = { subject: "A hand holding a paper boat", human: "a hand releasing it", avoid: ["clocks"] };

  it("is byte-stable for the same brief and slug", () => {
    // This *is* "consistent across posts": the style half of the prompt must
    // be identical every time or the covers stop being a set.
    assert.equal(buildCoverPrompt(brief, "a-post"), buildCoverPrompt(brief, "a-post"));
  });

  it("states the palette verbatim", () => {
    const prompt = buildCoverPrompt(brief, "a-post");
    assert.match(prompt, /pure black #000000, pure white #ffffff, and one\nhot orange #ff5a1f/);
    assert.match(prompt, /No fourth colour/);
    assert.match(prompt, /twelve per cent on the left and right edges/);
    assert.match(prompt, /Never include: text, letters, numbers, logos/);
  });

  it("varies the composition by slug, but deterministically", () => {
    const layouts = new Set(
      ["one", "two", "three", "four", "five", "six"].map((slug) => layoutFor(slug)),
    );
    assert.ok(layouts.size > 1, "every post would get the same composition");
    assert.equal(layoutFor("a-post"), layoutFor("a-post"), "not deterministic");
  });

  it("falls back to the house default when the human element was stripped", () => {
    const prompt = buildCoverPrompt({ ...brief, human: "" }, "a-post");
    assert.match(prompt, /Human element: a single hand, entering from one edge/);
  });
});

describe("suggestion schema construction", () => {
  it("omits the enum properties when there is no vocabulary", () => {
    /*
      An empty `enum` array is an invalid schema and Gemini 400s on it — which
      would break the feature on a brand-new blog, the worst possible first
      impression.
    */
    const schema = buildSuggestSchema([], []);
    assert.ok(!schema.properties?.existing_tags, "sent an empty tag enum");
    assert.ok(!schema.properties?.series_slug, "sent an empty series enum");
    assert.ok(schema.properties?.titles, "dropped the properties that do not need a vocabulary");
  });

  it("constrains to the real vocabulary when there is one", () => {
    const schema = buildSuggestSchema(["letters"], ["a-series"]);
    assert.deepEqual(schema.properties?.existing_tags?.items?.enum, ["letters"]);
    assert.deepEqual(schema.properties?.series_slug?.enum, ["a-series", "none"]);
  });
});

describe("post-verification of a whole response", () => {
  const blocks: Block[] = [
    { type: "heading", id: "h", level: 2, text: "The argument", spans: [] },
    {
      type: "paragraph",
      id: "p",
      text: "Software gets faster and the waiting stays exactly the same as it always was.",
      spans: [],
    },
  ];

  it("drops a title identical to the current one", () => {
    const result = verifySuggestions(
      {
        titles: ["On Slow Software", "a completely different title here"],
        excerpt: undefined,
        meta_description: undefined,
        existing_tags: [],
        new_tags: [],
        series_slug: undefined,
        keywords: [],
        quotes: [],
      },
      {
        key: "k", model: "m", title: "On Slow Software", blocks,
        vocabulary: [], series: [], currentTags: [], hasSeries: false,
      },
    );
    assert.deepEqual(result.titles, ["a completely different title here"]);
  });

  it("drops a hallucinated quote and keeps a real one", () => {
    const result = verifySuggestions(
      {
        titles: [], excerpt: undefined, meta_description: undefined,
        existing_tags: [], new_tags: [], series_slug: undefined, keywords: [],
        quotes: [
          "Software gets faster and the waiting stays exactly the same as it always was.",
          "A sentence the author never wrote anywhere in this particular draft.",
        ],
      },
      {
        key: "k", model: "m", title: "T", blocks,
        vocabulary: [], series: [], currentTags: [], hasSeries: false,
      },
    );
    assert.equal(result.quotes.length, 1);
    assert.match(result.quotes[0], /^Software gets faster/);
  });

  it("suggests no series for a post that already has one", () => {
    const result = verifySuggestions(
      {
        titles: [], excerpt: undefined, meta_description: undefined,
        existing_tags: [], new_tags: [], series_slug: "a-series", keywords: [], quotes: [],
      },
      {
        key: "k", model: "m", title: "T", blocks, vocabulary: [],
        series: [{ id: "s", slug: "a-series", title: "A Series" }],
        currentTags: [], hasSeries: true,
      },
    );
    assert.equal(result.series, null, "a deliberate choice was overwritten by a guess");
  });

  it("drops an analysis finding that hands the draft back", () => {
    const analysis = verifyAnalysis(
      {
        shape: [],
        opening: { verdict: "vague", note: "The opening states a mood and no reason to read on." },
        ending: { verdict: "abrupt", note: "It stops rather than lands." },
        strengths: [],
        weaknesses: [
          {
            problem:
              "Software gets faster and the waiting stays exactly the same as it always was.",
            fix: "Cut the repetition in the third paragraph.",
            severity: "worth_fixing",
          },
        ],
        one_thing: "Give the ending something to land on.",
      },
      blocks,
    );
    assert.deepEqual(analysis.weaknesses, [], "a regurgitated finding survived");
    assert.equal(analysis.one_thing, "Give the ending something to land on.");
  });

  it("keeps a finding but drops an anchor that points nowhere", () => {
    const analysis = verifyAnalysis(
      {
        shape: [],
        opening: { verdict: "strong", note: "It starts in the middle of something." },
        ending: { verdict: "lands", note: "The last line answers the first." },
        strengths: [],
        weaknesses: [
          {
            problem: "The middle section repeats its own premise.",
            where: "A Section That Does Not Exist",
            fix: "Cut the second statement of it.",
            severity: "minor",
          },
        ],
        one_thing: "Tighten the middle.",
      },
      blocks,
    );
    assert.equal(analysis.weaknesses.length, 1, "the finding was dropped with its anchor");
    assert.equal(analysis.weaknesses[0].where, null);
  });

  it("collapses the same complaint restated at three severities", () => {
    const same = "The middle section repeats its own premise at length";
    const analysis = verifyAnalysis(
      {
        shape: [],
        opening: { verdict: "strong", note: "Fine." },
        ending: { verdict: "lands", note: "Fine." },
        strengths: [],
        weaknesses: [
          { problem: `${same} once`, fix: "Cut it.", severity: "blocking" },
          { problem: `${same} twice`, fix: "Cut it.", severity: "worth_fixing" },
          { problem: `${same} again`, fix: "Cut it.", severity: "minor" },
        ],
        one_thing: "Tighten the middle.",
      },
      blocks,
    );
    assert.equal(analysis.weaknesses.length, 1);
  });
});
