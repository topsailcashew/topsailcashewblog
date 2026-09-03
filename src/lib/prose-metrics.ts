import type { Block } from "./blocks";

/**
 * Readability arithmetic — the Hemingway half of the writing panel.
 *
 * Deliberately no model. Everything Hemingway shows on screen is countable:
 * sentence length, adverbs, passive voice, wordy phrases, reading grade. A
 * model asked to count adverbs in four thousand words miscounts, and miscounts
 * differently on each run — and the single most valuable property of a
 * readability meter is that the number goes down when you fix something.
 *
 * Pure and dependency-free, because both sides import it: the editor panel in
 * the browser, and the analysis route on the server, which sends these numbers
 * to Gemini as settled facts so the model does not waste output re-deriving
 * statistics it would get wrong.
 *
 * Offsets are returned throughout, so the same module serves the panel's
 * summary and the inline highlighter.
 */

export type Level = "plain" | "hard" | "very_hard";

export type Sentence = {
  text: string;
  /** Offsets into the block's own text. */
  start: number;
  end: number;
  words: number;
  ari: number;
  level: Level;
};

export type FlagKind = "adverb" | "passive" | "wordy";

export type Flag = {
  kind: FlagKind;
  start: number;
  end: number;
  text: string;
  /** For a wordy phrase, what to use instead. */
  hint?: string;
};

/** One prose block, measured. Code and images contribute nothing. */
export type BlockMetrics = {
  id: string;
  text: string;
  sentences: Sentence[];
  flags: Flag[];
};

export type ProseMetrics = {
  words: number;
  sentences: number;
  paragraphs: number;
  /** Automated Readability Index, rounded. */
  grade: number;
  /** Flesch Reading Ease, 0–100. Higher is easier. */
  ease: number;
  readingMinutes: number;
  hard: number;
  veryHard: number;
  adverbs: number;
  passive: number;
  wordy: number;
  /** Hemingway's allowances, so the panel shows a target rather than a count. */
  budgets: { adverbs: number; passive: number };
  /** The worst offenders, for the panel to list. Longest first. */
  worst: { blockId: string; text: string; words: number; level: Level }[];
  blocks: BlockMetrics[];
};

/**
 * Thresholds, exported so tests pin them and there is one place to tune.
 *
 * Level combines length *and* density on purpose. Length alone flags a
 * thirty-word sentence of one-syllable words that reads perfectly well, and
 * misses a nine-word sentence of Latinate abstractions that does not.
 */
export const THRESHOLDS = {
  hardWords: 18,
  veryHardWords: 26,
  hardAri: 10,
  veryHardAri: 14,
  /** Below this a sentence is too short for density to mean anything. */
  minWordsForAri: 10,
  minWordsForVeryHardAri: 14,
} as const;

const WORDS_PER_MINUTE = 200;

/* --- sentence segmentation ---------------------------------------------- */

/**
 * Abbreviations that end in a full stop without ending a sentence.
 *
 * Hand-rolled rather than `Intl.Segmenter`. Segmenter would save forty lines,
 * but its sentence rules come from ICU, which differs between Node (where the
 * tests run) and workerd (where this runs), and shifts with runtime versions.
 * A metric whose value depends on the V8 build is not a metric.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "etc", "eg", "ie",
  "no", "fig", "vol", "op", "cit", "al", "approx", "dept", "est", "inc", "ltd",
  "co", "corp", "univ", "ave", "blvd", "rd", "pp", "ed", "trans", "cf",
]);

/**
 * Splits text into sentences.
 *
 * The cases that matter, all covered by tests: an abbreviation ("Dr. Who"), a
 * decimal ("version 2.5"), an ellipsis, a single initial ("T. S. Eliot"), and
 * a quotation whose closing mark follows the terminator ("Really?" he said).
 */
export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== "." && char !== "!" && char !== "?") continue;

    // Run past a cluster of terminators and any closing quotes or brackets.
    let end = i;
    while (end + 1 < text.length && ".!?".includes(text[end + 1])) end += 1;
    while (end + 1 < text.length && `"'”’)]`.includes(text[end + 1])) end += 1;

    if (char === "." && !isSentenceEnd(text, i)) {
      i = end;
      continue;
    }

    // A sentence ends only where whitespace or the text itself follows.
    const next = text[end + 1];
    if (next !== undefined && !/\s/.test(next)) {
      i = end;
      continue;
    }

    /*
      `"Really?" he said.` is one sentence, not two. A terminator inside
      quotation marks ends the quote, and if what follows the closing mark is
      lowercase then the sentence carries on around it. An uppercase word after
      the quote is a genuine new sentence.
    */
    if (end > i) {
      const after = text.slice(end + 1).match(/^\s*(\S)/)?.[1];
      if (after && after === after.toLowerCase() && /[a-z]/.test(after)) {
        i = end;
        continue;
      }
    }

    const slice = text.slice(start, end + 1).trim();
    if (slice !== "") {
      const lead = text.slice(start, end + 1).length - text.slice(start, end + 1).trimStart().length;
      out.push({ text: slice, start: start + lead, end: start + lead + slice.length });
    }
    start = end + 1;
    i = end;
  }

  const tail = text.slice(start).trim();
  if (tail !== "") {
    const lead = text.slice(start).length - text.slice(start).trimStart().length;
    out.push({ text: tail, start: start + lead, end: start + lead + tail.length });
  }
  return out;
}

/** Whether a full stop at `index` terminates a sentence. */
function isSentenceEnd(text: string, index: number): boolean {
  const before = text.slice(0, index);

  // "2.5" — a digit either side is a decimal, not a stop.
  if (/\d$/.test(before) && /^\d/.test(text.slice(index + 1))) return false;

  // "..." is an ellipsis; treat it as a stop only at the very end of the text.
  if (text.slice(index, index + 3) === "..." ) {
    return /^\s*$/.test(text.slice(index + 3));
  }

  const word = before.match(/([A-Za-z]+)$/)?.[1];
  if (!word) return true;

  /*
    A single letter before a stop is an initial ("T. S. Eliot") or the tail of
    a dotted abbreviation ("e.g."). The false negative — a sentence that
    genuinely ends on a lone letter — does not occur in prose, and treating one
    as a sentence break splits every citation and every set of initials.
  */
  if (word.length === 1) return false;
  return !ABBREVIATIONS.has(word.toLowerCase());
}

/* --- word and syllable counting ------------------------------------------ */

export function countWords(text: string): number {
  return (text.match(/[A-Za-z0-9'’-]+/g) ?? []).length;
}

/**
 * Vowel-group syllable estimate, with the usual corrections.
 *
 * Only Flesch needs this; the grade shown in the panel is ARI, which counts
 * characters and needs no heuristic at all.
 */
export function syllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");
  if (clean.length === 0) return 0;
  if (clean.length <= 3) return 1;

  const trimmed = clean
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "");
  return Math.max(1, (trimmed.match(/[aeiouy]+/g) ?? []).length);
}

/**
 * Automated Readability Index: 4.71·(chars/words) + 0.5·(words/sentences) − 21.43.
 *
 * Character-based, so no syllable heuristic is in the loop, and it is what
 * Hemingway's grade number actually approximates.
 */
export function ari(text: string): number {
  const words = countWords(text);
  if (words === 0) return 0;
  const chars = (text.match(/[A-Za-z0-9]/g) ?? []).length;
  const sentences = Math.max(1, splitSentences(text).length);
  return 4.71 * (chars / words) + 0.5 * (words / sentences) - 21.43;
}

export function gradeSentence(text: string): { words: number; ari: number; level: Level } {
  const words = countWords(text);
  const score = ari(text);

  const veryHard =
    words >= THRESHOLDS.veryHardWords ||
    (score >= THRESHOLDS.veryHardAri && words >= THRESHOLDS.minWordsForVeryHardAri);
  const hard =
    words >= THRESHOLDS.hardWords ||
    (score >= THRESHOLDS.hardAri && words >= THRESHOLDS.minWordsForAri);

  return { words, ari: score, level: veryHard ? "very_hard" : hard ? "hard" : "plain" };
}

/* --- flags ---------------------------------------------------------------- */

/** Words ending in -ly that are not adverbs. */
const NOT_ADVERBS = new Set([
  "only", "family", "reply", "apply", "supply", "likely", "early", "holy",
  "ugly", "silly", "july", "italy", "rely", "imply", "assembly", "anomaly",
  "jelly", "belly", "ally", "bully", "multiply", "monopoly", "panoply",
  "melancholy", "lovely", "friendly", "lonely", "daily", "weekly", "monthly",
  "yearly", "elderly", "orderly", "costly", "deadly", "unruly", "wobbly",
]);

/**
 * Irregular past participles.
 *
 * This list is what makes passive detection work at all: "was written" is
 * passive and "was tired" is not, and no `-ed` rule distinguishes them.
 */
const PARTICIPLES = new Set([
  "known", "done", "made", "seen", "said", "given", "taken", "shown", "held",
  "written", "born", "built", "found", "kept", "left", "lost", "paid", "put",
  "read", "sent", "set", "told", "thought", "understood", "won", "brought",
  "bought", "caught", "chosen", "cut", "drawn", "driven", "eaten", "fallen",
  "felt", "forgotten", "got", "gotten", "heard", "hidden", "hit", "hurt",
  "led", "meant", "met", "spent", "spoken", "stolen", "struck", "taught",
  "thrown", "worn", "beaten", "become", "begun", "bent", "bound", "broken",
  "burnt", "dealt", "drunk", "flown", "frozen", "grown", "laid", "lent",
  "let", "lit", "proven", "risen", "shot", "shut", "sold", "sought", "sung",
  "sunk", "slept", "split", "spread", "stood", "sworn", "swept", "torn",
  "woken", "withdrawn",
]);

const AUXILIARIES = ["am", "is", "are", "was", "were", "be", "been", "being"];

/**
 * `-ed` words that are adjectives after an auxiliary, not passive verbs.
 *
 * "The window was smashed" is passive; "he was tired" is a state. Both end in
 * -ed and both follow an auxiliary, so no structural rule separates them —
 * only a list does. Hemingway itself over-flags here; this trades a handful of
 * missed detections for not crying wolf on the most common phrasings, which is
 * the right way round for a meter the writer is supposed to trust.
 */
const ADJECTIVAL_ED = new Set([
  "tired", "interested", "bored", "worried", "excited", "pleased", "concerned",
  "scared", "surprised", "confused", "embarrassed", "frustrated", "satisfied",
  "disappointed", "exhausted", "relaxed", "amazed", "annoyed", "ashamed",
  "astonished", "delighted", "depressed", "determined", "devoted", "engaged",
  "frightened", "married", "prepared", "retired", "sophisticated", "unexpected",
  "aged", "beloved", "crowded", "dated", "detailed", "experienced", "gifted",
  "interested", "learned", "mixed", "opposed", "prejudiced", "qualified",
  "skilled", "supposed", "talented", "troubled", "wicked", "willing",
]);

/** Long-winded phrases and their short forms. Hemingway's purple highlight. */
const WORDY: Record<string, string> = {
  "a number of": "many",
  "a majority of": "most",
  "a sufficient amount of": "enough",
  "at the present time": "now",
  "at this point in time": "now",
  "along the lines of": "like",
  "as a matter of fact": "in fact",
  "at all times": "always",
  "based on the fact that": "because",
  "by means of": "by",
  "by virtue of": "by",
  "come to a conclusion": "conclude",
  "despite the fact that": "although",
  "due to the fact that": "because",
  "during the course of": "during",
  "for the purpose of": "to",
  "for the reason that": "because",
  "give consideration to": "consider",
  "has the ability to": "can",
  "in a timely manner": "promptly",
  "in the event that": "if",
  "in the near future": "soon",
  "in order to": "to",
  "in spite of the fact that": "although",
  "in terms of": "in",
  "in the process of": "",
  "is able to": "can",
  "it is important to note that": "",
  "make a decision": "decide",
  "make an attempt": "try",
  "on a regular basis": "regularly",
  "on the grounds that": "because",
  "prior to": "before",
  "provide assistance": "help",
  "subsequent to": "after",
  "take into consideration": "consider",
  "the fact that": "that",
  "there is no doubt that": "doubtless",
  "utilize": "use",
  "utilise": "use",
  "utilization": "use",
  "with regard to": "about",
  "with the exception of": "except",
  "in close proximity to": "near",
  "a large number of": "many",
  "an increased number of": "more",
  "at such time as": "when",
  "in the absence of": "without",
  "of considerable magnitude": "large",
  "referred to as": "called",
  "the question as to whether": "whether",
  "this is a subject that": "this subject",
  "used for the purpose of": "used to",
  "was of the opinion that": "believed",
  "whether or not": "whether",
  "each and every": "each",
  "first and foremost": "first",
  "few in number": "few",
  "end result": "result",
  "past history": "history",
  "close down": "close",
};

const WORDY_PATTERN = new RegExp(
  `\\b(${Object.keys(WORDY)
    .sort((a, b) => b.length - a.length) // Longest first, so the specific wins.
    .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "gi",
);

const PASSIVE_PATTERN = new RegExp(
  `\\b(${AUXILIARIES.join("|")})\\s+(\\w+)\\b`,
  "gi",
);

export function findFlags(text: string): Flag[] {
  const flags: Flag[] = [];

  for (const match of text.matchAll(/\b[A-Za-z]+ly\b/g)) {
    if (NOT_ADVERBS.has(match[0].toLowerCase())) continue;
    flags.push({
      kind: "adverb",
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }

  for (const match of text.matchAll(PASSIVE_PATTERN)) {
    const participle = match[2].toLowerCase();
    if (ADJECTIVAL_ED.has(participle)) continue;
    // `-ed` catches the regular participles; the irregular list catches the
    // rest, and is what makes "was written" work where no suffix rule would.
    const passive = PARTICIPLES.has(participle) || /\w{3,}ed$/.test(participle);
    if (!passive) continue;
    flags.push({
      kind: "passive",
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }

  for (const match of text.matchAll(WORDY_PATTERN)) {
    const hint = WORDY[match[0].toLowerCase()];
    flags.push({
      kind: "wordy",
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      ...(hint ? { hint } : {}),
    });
  }

  return flags.sort((a, b) => a.start - b.start);
}

/* --- the aggregate -------------------------------------------------------- */

/**
 * Which blocks are prose.
 *
 * Headings and code are excluded from sentence grading, as Hemingway excludes
 * them: a heading is not a sentence and a code block is not English. Both
 * still count toward the word total, because they are still on the page.
 */
function isProse(block: Block): boolean {
  return block.type === "paragraph" || block.type === "quote" || block.type === "list";
}

/** Every block's text, whether or not it is graded. */
function textOf(block: Block): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
      return block.text;
    case "list":
      return block.items.map((item) => item.text).join("\n");
    case "code":
      return block.code;
    default:
      return "";
  }
}

export function measure(blocks: Block[]): ProseMetrics {
  const measured: BlockMetrics[] = [];
  let words = 0;
  let sentenceCount = 0;
  let paragraphs = 0;
  let chars = 0;
  let syllableCount = 0;
  let hard = 0;
  let veryHard = 0;
  const tally: Record<FlagKind, number> = { adverb: 0, passive: 0, wordy: 0 };
  const worst: ProseMetrics["worst"] = [];

  for (const block of blocks) {
    const text = textOf(block);
    words += countWords(text);

    if (!isProse(block) || text.trim() === "") continue;
    paragraphs += 1;

    const sentences: Sentence[] = splitSentences(text).map((sentence) => {
      const graded = gradeSentence(sentence.text);
      return { ...sentence, ...graded };
    });

    for (const sentence of sentences) {
      sentenceCount += 1;
      chars += (sentence.text.match(/[A-Za-z0-9]/g) ?? []).length;
      for (const word of sentence.text.match(/[A-Za-z']+/g) ?? []) {
        syllableCount += syllables(word);
      }
      if (sentence.level === "very_hard") veryHard += 1;
      else if (sentence.level === "hard") hard += 1;

      if (sentence.level !== "plain") {
        worst.push({
          blockId: block.id,
          text: sentence.text,
          words: sentence.words,
          level: sentence.level,
        });
      }
    }

    const flags = findFlags(text);
    for (const flag of flags) tally[flag.kind] += 1;

    measured.push({ id: block.id, text, sentences, flags });
  }

  const safeWords = Math.max(1, words);
  const safeSentences = Math.max(1, sentenceCount);

  const grade =
    sentenceCount === 0
      ? 0
      : 4.71 * (chars / safeWords) + 0.5 * (safeWords / safeSentences) - 21.43;

  const ease =
    sentenceCount === 0
      ? 0
      : 206.835 - 1.015 * (safeWords / safeSentences) - 84.6 * (syllableCount / safeWords);

  return {
    words,
    sentences: sentenceCount,
    paragraphs,
    grade: Math.max(0, Math.round(grade)),
    ease: Math.max(0, Math.min(100, Math.round(ease))),
    readingMinutes: Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)),
    hard,
    veryHard,
    adverbs: tally.adverb,
    passive: tally.passive,
    wordy: tally.wordy,
    // Hemingway's allowances: one adverb per hundred words, one passive
    // construction per five sentences.
    budgets: {
      adverbs: Math.floor(words / 100),
      passive: Math.floor(sentenceCount / 5),
    },
    worst: worst.sort((a, b) => b.words - a.words).slice(0, 5),
    blocks: measured,
  };
}

/** A plain-English gloss of the grade, for the panel. */
export function gradeLabel(grade: number): string {
  if (grade <= 6) return "very easy";
  if (grade <= 9) return "easy";
  if (grade <= 12) return "fair";
  if (grade <= 15) return "hard";
  return "very hard";
}

/** One line of numbers, for the Gemini prompt. */
export function metricsSummary(metrics: ProseMetrics): string {
  return [
    `${metrics.words} words`,
    `${metrics.sentences} sentences`,
    `${metrics.paragraphs} paragraphs`,
    `reading grade ${metrics.grade}`,
    `${metrics.hard} hard and ${metrics.veryHard} very hard sentences`,
    `${metrics.adverbs} adverbs (budget ${metrics.budgets.adverbs})`,
    `${metrics.passive} passive constructions (budget ${metrics.budgets.passive})`,
    `${metrics.wordy} wordy phrases`,
  ].join(", ");
}
