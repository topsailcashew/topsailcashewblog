import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Block } from "@/lib/blocks";
import {
  THRESHOLDS,
  ari,
  countWords,
  findFlags,
  gradeSentence,
  measure,
  metricsSummary,
  splitSentences,
  syllables,
} from "@/lib/prose-metrics";

const para = (text: string, id = "b1"): Block => ({
  type: "paragraph",
  id,
  text,
  spans: [],
});

describe("sentence segmentation", () => {
  it("splits on the three terminators", () => {
    assert.deepEqual(
      splitSentences("One. Two! Three?").map((s) => s.text),
      ["One.", "Two!", "Three?"],
    );
  });

  it("does not split on an abbreviation", () => {
    // The classic false positive. "Dr." is not the end of anything.
    assert.deepEqual(
      splitSentences("Dr. Who arrived. He was late.").map((s) => s.text),
      ["Dr. Who arrived.", "He was late."],
    );
    assert.equal(splitSentences("Use e.g. this one.").length, 1);
    assert.equal(splitSentences("Mrs. Dalloway said she would buy them.").length, 1);
  });

  it("does not split a decimal", () => {
    assert.equal(splitSentences("We shipped version 2.5 on Friday.").length, 1);
  });

  it("does not split initials", () => {
    assert.equal(splitSentences("T. S. Eliot wrote it.").length, 1);
  });

  it("keeps a closing quote with the sentence it ends", () => {
    const sentences = splitSentences('"Really?" he said. Then he left.');
    assert.deepEqual(sentences.map((s) => s.text), ['"Really?" he said.', "Then he left."]);
  });

  it("treats a trailing ellipsis as one stop, not three", () => {
    assert.equal(splitSentences("It trailed off...").length, 1);
  });

  it("returns offsets that slice the original text back out", () => {
    // The highlighter maps these straight onto document positions, so an
    // off-by-one here paints the wrong words.
    const text = "First one. Second one here.";
    for (const sentence of splitSentences(text)) {
      assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
    }
  });

  it("handles text with no terminator at all", () => {
    assert.deepEqual(splitSentences("no full stop here").map((s) => s.text), [
      "no full stop here",
    ]);
    assert.deepEqual(splitSentences(""), []);
    assert.deepEqual(splitSentences("   "), []);
  });
});

describe("counting", () => {
  it("counts hyphenated and apostrophed words as one", () => {
    assert.equal(countWords("It's a well-known problem"), 4);
  });

  it("estimates syllables well enough for Flesch", () => {
    assert.equal(syllables("cat"), 1);
    assert.equal(syllables("running"), 2);
    assert.equal(syllables("beautiful"), 3);
    assert.equal(syllables(""), 0);
  });

  it("computes ARI from characters, not syllables", () => {
    // Short words, short sentence: a low grade.
    assert.ok(ari("The cat sat on the mat.") < 3);
    // Long Latinate words: a high one, at the same sentence length.
    assert.ok(ari("Constitutional interpretation necessitates jurisprudential consideration.") > 15);
  });

  it("returns zero rather than dividing by zero", () => {
    assert.equal(ari(""), 0);
  });
});

describe("sentence grading", () => {
  it("flags a long sentence as hard at the threshold", () => {
    const atThreshold = Array(THRESHOLDS.hardWords).fill("word").join(" ") + ".";
    const under = Array(THRESHOLDS.hardWords - 1).fill("word").join(" ") + ".";
    assert.equal(gradeSentence(atThreshold).level, "hard");
    assert.equal(gradeSentence(under).level, "plain");
  });

  it("escalates to very hard at its own threshold", () => {
    const atThreshold = Array(THRESHOLDS.veryHardWords).fill("word").join(" ") + ".";
    assert.equal(gradeSentence(atThreshold).level, "very_hard");
  });

  it("flags a short dense sentence that length alone would miss", () => {
    // Eleven words, but every one of them Latinate.
    const dense =
      "Constitutional jurisprudence necessitates comprehensive interpretative methodology across administrative adjudicative institutional frameworks.";
    const graded = gradeSentence(dense);
    assert.ok(graded.words < THRESHOLDS.hardWords, "the length rule would have caught it");
    assert.notEqual(graded.level, "plain");
  });

  it("leaves a long sentence of plain words alone if it reads easily", () => {
    // Fourteen short words — over the ARI floor but under the length rule.
    assert.equal(gradeSentence("I went to the shop and I got a pint of milk for tea.").level, "plain");
  });
});

describe("flags", () => {
  it("finds adverbs but not words that merely end in -ly", () => {
    const flags = findFlags("She quickly left, but only the family reply mattered.");
    const adverbs = flags.filter((f) => f.kind === "adverb").map((f) => f.text);
    assert.deepEqual(adverbs, ["quickly"]);
  });

  it("finds passive voice, regular and irregular", () => {
    const regular = findFlags("The window was smashed by the storm.");
    assert.ok(regular.some((f) => f.kind === "passive" && f.text === "was smashed"));

    const irregular = findFlags("The letter was written last year.");
    assert.ok(
      irregular.some((f) => f.kind === "passive" && f.text === "was written"),
      "the irregular participle list is what makes this work",
    );
  });

  it("does not call an adjective passive", () => {
    // "was tired" is a state, not an action done to anyone. No -ed rule and no
    // participle list catches it, which is exactly why both are needed.
    const flags = findFlags("He was tired and the room was quiet.");
    assert.deepEqual(flags.filter((f) => f.kind === "passive"), []);
  });

  it("finds wordy phrases and suggests the short form", () => {
    const flags = findFlags("In order to proceed we must utilize a number of tools.");
    const wordy = flags.filter((f) => f.kind === "wordy");
    assert.deepEqual(
      wordy.map((f) => [f.text.toLowerCase(), f.hint]),
      [["in order to", "to"], ["utilize", "use"], ["a number of", "many"]],
    );
  });

  it("returns offsets that slice the flagged text back out", () => {
    const text = "She quickly wrote that in order to finish.";
    for (const flag of findFlags(text)) {
      assert.equal(text.slice(flag.start, flag.end), flag.text);
    }
  });

  it("returns flags in document order", () => {
    const flags = findFlags("Utilize this. She quickly left. It was written.");
    const starts = flags.map((f) => f.start);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });
});

describe("measuring a document", () => {
  it("counts words, sentences and paragraphs", () => {
    const metrics = measure([
      para("One sentence here. And a second one.", "a"),
      para("A third, alone.", "b"),
    ]);
    assert.equal(metrics.sentences, 3);
    assert.equal(metrics.paragraphs, 2);
    assert.equal(metrics.words, countWords("One sentence here. And a second one.") + 3);
  });

  it("counts a code block's words but does not grade its sentences", () => {
    const blocks: Block[] = [
      para("A real sentence goes here.", "a"),
      { type: "code", id: "b", language: "ts", code: "const x = 1; const y = 2;" },
    ];
    const metrics = measure(blocks);
    assert.equal(metrics.sentences, 1, "code was graded as prose");
    assert.ok(metrics.words > 5, "code did not count toward the word total");
    assert.ok(!metrics.blocks.some((b) => b.id === "b"));
  });

  it("does not grade a heading as a sentence", () => {
    const blocks: Block[] = [
      { type: "heading", id: "h", level: 2, text: "A heading with several words in it", spans: [] },
      para("One sentence.", "a"),
    ];
    assert.equal(measure(blocks).sentences, 1);
  });

  it("sets budgets the way Hemingway does", () => {
    const words = Array(250).fill("word").join(" ") + ".";
    const metrics = measure([para(words)]);
    assert.equal(metrics.budgets.adverbs, 2, "one adverb per hundred words");
  });

  it("lists the worst sentences longest first", () => {
    const long = Array(30).fill("word").join(" ") + ".";
    const medium = Array(20).fill("word").join(" ") + ".";
    const metrics = measure([para(`Short one. ${medium} ${long}`)]);

    assert.equal(metrics.worst[0].words, 30);
    assert.equal(metrics.worst[0].level, "very_hard");
    assert.equal(metrics.worst[1].words, 20);
    assert.ok(metrics.worst.length <= 5);
  });

  it("returns zeros for an empty document without dividing by zero", () => {
    const metrics = measure([]);
    assert.equal(metrics.words, 0);
    assert.equal(metrics.sentences, 0);
    assert.equal(metrics.grade, 0);
    assert.equal(metrics.ease, 0);
    assert.ok(Number.isFinite(metrics.grade));
    assert.ok(Number.isFinite(metrics.ease));
    assert.equal(metrics.readingMinutes, 1);
  });

  it("survives a document of only an image and a divider", () => {
    const blocks: Block[] = [
      { type: "image", id: "i", src: "/a.png", alt: "" },
      { type: "divider", id: "d" },
    ];
    assert.doesNotThrow(() => measure(blocks));
    assert.equal(measure(blocks).sentences, 0);
  });

  it("measures a list's items as prose", () => {
    const blocks: Block[] = [
      {
        type: "list",
        id: "l",
        ordered: false,
        items: [
          { text: "The first item, which is a sentence.", spans: [] },
          { text: "The second item.", spans: [] },
        ],
      },
    ];
    assert.equal(measure(blocks).sentences, 2);
  });

  it("produces a summary line the prompt can hand to the model as fact", () => {
    const summary = metricsSummary(measure([para("She quickly left. It was written.")]));
    assert.match(summary, /words/);
    assert.match(summary, /reading grade \d+/);
    assert.match(summary, /1 adverbs? \(budget \d+\)/);
  });
});
