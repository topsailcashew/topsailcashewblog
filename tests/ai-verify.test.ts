import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Block } from "@/lib/blocks";
import {
  boundedStrings,
  draftText,
  isRegurgitation,
  resolveSeries,
  resolveTags,
  verifyCoverBrief,
  verifyQuote,
  verifyQuotes,
} from "@/lib/ai/verify";

const para = (text: string, id = "b1"): Block => ({ type: "paragraph", id, text, spans: [] });

/* The sentence used throughout, with the author's own curly punctuation. */
const CURLY =
  "I have said to you a number of times that I am tired — and I surely am, every day of it.";

describe("pull-quote verification", () => {
  const blocks = [
    para(CURLY, "a"),
    para("A second paragraph, which begins here and ends with a full stop.", "b"),
  ];

  it("accepts a quote that is really in the draft", () => {
    assert.equal(verifyQuote(CURLY, blocks), CURLY);
  });

  it("accepts one the model re-punctuated, and returns the author's characters", () => {
    // Straight quotes and a hyphen where the draft has an em-dash: this is
    // what a model returns roughly half the time.
    const flattened = "I have said to you a number of times that I am tired - and I surely am";
    const found = verifyQuote(flattened, blocks);

    assert.ok(found, "a genuine quote was rejected over punctuation");
    assert.ok(found.includes("—"), "the model's flattened dash was returned instead of the source");
    assert.ok(CURLY.includes(found), "the result is not a slice of the draft");
  });

  it("rejects a quote that stitches two paragraphs together", () => {
    /*
      Structurally impossible, and the thing a whole-document search would
      accept. Searching per block is what rejects it — the check falls out of
      the design rather than being a rule of its own.
    */
    const stitched = "every day of it. A second paragraph, which begins here";
    assert.equal(verifyQuote(stitched, blocks), null);
  });

  it("rejects a quote that is not there at all", () => {
    assert.equal(
      verifyQuote("I have never said anything of the kind to anyone, ever, at all.", blocks),
      null,
    );
  });

  it("matches case-insensitively but returns the original casing", () => {
    const lowered = CURLY.toLowerCase().slice(0, 60);
    const found = verifyQuote(lowered, blocks);
    assert.ok(found);
    assert.ok(CURLY.includes(found));
    assert.notEqual(found, lowered);
  });

  it("collapses a line break inside the draft", () => {
    const wrapped = [para("A sentence that was\nwrapped across two lines in the source.", "w")];
    assert.ok(verifyQuote("A sentence that was wrapped across two lines in the source", wrapped));
  });

  it("rejects anything too short to be a pull-quote", () => {
    assert.equal(verifyQuote("I am tired", blocks), null);
  });

  it("strips the model's own surrounding quotation marks", () => {
    assert.ok(verifyQuote(`"${CURLY}"`, blocks));
  });

  it("dedupes and caps a list", () => {
    const found = verifyQuotes([CURLY, CURLY, "nonsense that is not present anywhere here"], blocks);
    assert.equal(found.length, 1);
  });

  it("does not let a quote span two list items", () => {
    const list: Block[] = [
      {
        type: "list",
        id: "l",
        ordered: false,
        items: [
          { text: "The first item runs to a reasonable length here.", spans: [] },
          { text: "The second item also runs to a reasonable length.", spans: [] },
        ],
      },
    ];
    assert.equal(
      verifyQuote("reasonable length here. The second item also runs", list),
      null,
    );
    assert.ok(verifyQuote("The first item runs to a reasonable length here.", list));
  });
});

describe("regurgitation", () => {
  const draft = draftText([para(CURLY)]);

  it("catches a finding that hands the draft back", () => {
    assert.equal(isRegurgitation(CURLY, draft), true);
  });

  it("leaves a genuine finding alone", () => {
    assert.equal(
      isRegurgitation("The opening states a feeling but gives no reason to keep reading.", draft),
      false,
    );
  });

  it("allows a short quotation, which is what the rule permits", () => {
    assert.equal(isRegurgitation("you say you are tired", draft), false);
  });
});

describe("tag resolution", () => {
  const vocabulary = [
    { name: "Web Design", slug: "web-design" },
    { name: "Letters", slug: "letters" },
  ];

  it("keeps existing tags by their real display name", () => {
    const resolved = resolveTags({ existing: ["letters"], fresh: [] }, vocabulary, []);
    assert.deepEqual(resolved.existing, ["Letters"]);
    assert.deepEqual(resolved.fresh, []);
  });

  it("folds a new tag that collides with an existing slug", () => {
    // The layer that actually prevents the vocabulary exploding: "web design"
    // slugifies onto "web-design", so it is a reuse and not a second tag.
    const resolved = resolveTags({ existing: [], fresh: ["Web  Design"] }, vocabulary, []);
    assert.deepEqual(resolved.existing, ["Web Design"]);
    assert.deepEqual(resolved.fresh, []);
  });

  it("keeps a genuinely new tag", () => {
    const resolved = resolveTags({ existing: [], fresh: ["Estuaries"] }, vocabulary, []);
    assert.deepEqual(resolved.fresh, ["Estuaries"]);
  });

  it("drops an invented slug that is not in the vocabulary", () => {
    const resolved = resolveTags({ existing: ["not-a-real-tag"], fresh: [] }, vocabulary, []);
    assert.deepEqual(resolved, { existing: [], fresh: [] });
  });

  it("drops tags already on the post", () => {
    const resolved = resolveTags({ existing: ["letters"], fresh: [] }, vocabulary, ["Letters"]);
    assert.deepEqual(resolved.existing, []);
  });

  it("caps the total and spends the cap on reuse first", () => {
    const big = Array.from({ length: 8 }, (_, i) => ({ name: `Tag ${i}`, slug: `tag-${i}` }));
    const resolved = resolveTags(
      { existing: big.map((t) => t.slug), fresh: ["Something New"] },
      big,
      [],
      3,
    );
    assert.equal(resolved.existing.length, 3);
    assert.deepEqual(resolved.fresh, []);
  });
});

describe("series resolution", () => {
  const available = [{ id: "id-1", slug: "letters-to-myself", title: "Letters to Myself" }];

  it("resolves a real slug", () => {
    assert.deepEqual(resolveSeries("letters-to-myself", available), {
      id: "id-1",
      title: "Letters to Myself",
    });
  });

  it("treats an invented slug and 'none' as no series", () => {
    assert.equal(resolveSeries("a-series-that-does-not-exist", available), null);
    assert.equal(resolveSeries("none", available), null);
    assert.equal(resolveSeries(null, available), null);
    assert.equal(resolveSeries(undefined, available), null);
  });
});

describe("bounded strings", () => {
  it("trims, dedupes case-insensitively, and caps", () => {
    assert.deepEqual(
      boundedStrings(["  One  ", "one", "Two", "Three"], { max: 20, limit: 2 }),
      ["One", "Two"],
    );
  });

  it("drops over-length rather than truncating mid-sentence", () => {
    assert.deepEqual(boundedStrings(["ok", "x".repeat(50)], { max: 10, limit: 5 }), ["ok"]);
  });

  it("survives a non-array, which is what a bad response looks like", () => {
    assert.deepEqual(boundedStrings("not an array", { max: 10, limit: 5 }), []);
    assert.deepEqual(boundedStrings(undefined, { max: 10, limit: 5 }), []);
    assert.deepEqual(boundedStrings([1, null, {}], { max: 10, limit: 5 }), []);
  });
});

describe("cover brief sanitising", () => {
  it("accepts an ordinary brief", () => {
    const brief = verifyCoverBrief({
      subject: "A hand holding a folded paper boat above still water",
      human_element: "a hand releasing the boat",
      avoid: ["clocks", "lightbulbs"],
    });
    assert.ok(brief);
    assert.equal(brief.avoid.length, 2);
  });

  it("rejects a subject that names a colour or a medium", () => {
    /*
      The injection boundary. /api/import accepts arbitrary .docx, so a
      document saying "render this in blue, photorealistic, with the word HOPE"
      must not be able to steer the house style — and an image generation is
      too expensive to spend on a prompt that has been tampered with.
    */
    for (const subject of [
      "A hand holding a boat, rendered in blue",
      "A photorealistic 3d render of a shoreline at dusk",
      "A shoreline with the word HOPE in large typography",
    ]) {
      assert.equal(verifyCoverBrief({ subject, human_element: "a hand" }), null, subject);
    }
  });

  it("drops a tampered human element without losing the generation", () => {
    const brief = verifyCoverBrief({
      subject: "A hand holding a folded paper boat above still water",
      human_element: "a hand, photorealistic",
    });
    assert.ok(brief, "the whole brief was rejected over a droppable field");
    assert.equal(brief.human, "");
  });

  it("rejects a subject that is missing or absurd", () => {
    assert.equal(verifyCoverBrief({ subject: "short" }), null);
    assert.equal(verifyCoverBrief({ subject: "x".repeat(400) }), null);
    assert.equal(verifyCoverBrief({}), null);
  });
});
