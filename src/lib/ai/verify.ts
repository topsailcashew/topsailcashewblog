import type { Block } from "../blocks";
import { slugify } from "../slug";

/**
 * What the server checks before it shows you anything a model said.
 *
 * A `responseSchema` is a polite request. It lowers the error rate and
 * guarantees nothing: enums come back as free strings, arrays come back longer
 * than `maxItems`, and a quote comes back that appears nowhere in the draft.
 * This module is the enforcement, and it is pure so that all of it is testable
 * without a network.
 *
 * The rule throughout: when a field fails, drop the field rather than the
 * finding, and drop the finding rather than the response — except where an
 * empty result would itself be a lie, which the callers handle.
 */

/* --- quotes --------------------------------------------------------------- */

/** Shorter than this is not a pull-quote, longer is not quotable. */
const MIN_QUOTE = 40;
const MAX_QUOTE = 240;

/**
 * Typographic variants folded together before comparison.
 *
 * A model re-renders curly quotes as straight ones and em-dashes as hyphens
 * roughly half the time. Comparing raw would reject a quote that is genuinely
 * in the draft, which is the failure that makes the feature useless.
 */
function normalise(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    let replacement: string;

    if (char === "‘" || char === "’" || char === "ʼ") replacement = "'";
    else if ("“”„«»".includes(char)) replacement = '"';
    else if ("–—‒".includes(char)) replacement = "-";
    else if (char === "…") replacement = "...";
    else if (char === "­" || char === "​") replacement = "";
    else if (/\s/.test(char)) {
      // Collapse runs of whitespace, including newlines, to one space.
      if (out.endsWith(" ")) continue;
      replacement = " ";
    } else replacement = char;

    for (const emitted of replacement) {
      out += emitted;
      map.push(i);
    }
  }

  return { text: out, map };
}

/**
 * Confirms a quote is really in the draft, and returns the author's own
 * characters for it.
 *
 * Searched **per block**, which is what rejects a quote stitched together
 * across two paragraphs — structurally impossible, and something a
 * whole-document search would happily accept. That check falls out of the
 * design rather than needing a rule of its own.
 *
 * On a hit the offset map converts back to the source, so the returned string
 * has the author's curly apostrophes and em-dashes rather than the model's
 * flattened rendition. A pull-quote that does not paste back
 * character-identical is a small betrayal.
 */
export function verifyQuote(candidate: string, blocks: Block[]): string | null {
  const stripped = candidate
    .trim()
    .replace(/^["'“‘]+/, "")
    .replace(/["'”’]+$/, "")
    .replace(/[.,;:\s]+$/, "")
    .trim();

  if (stripped.length < MIN_QUOTE || stripped.length > MAX_QUOTE) return null;

  const needle = normalise(stripped).text.toLowerCase();
  if (needle === "") return null;

  for (const block of blocks) {
    for (const source of textsOf(block)) {
      const { text: haystack, map } = normalise(source);
      const at = haystack.toLowerCase().indexOf(needle);
      if (at === -1) continue;

      const from = map[at];
      let to = map[at + needle.length - 1];
      if (from === undefined || to === undefined) continue;

      /*
        Trailing punctuation is stripped from the *candidate*, because a model
        adds and drops full stops freely. It is put back from the *source* when
        it is there: a pull-quote that ends without the sentence's own full
        stop reads as truncated, which is the opposite of what a verified
        quote should look like.
      */
      while (to + 1 < source.length && ".!?…".includes(source[to + 1])) to += 1;
      if (to + 1 < source.length && `"'”’`.includes(source[to + 1])) to += 1;

      return source.slice(from, to + 1);
    }
  }
  return null;
}

export function verifyQuotes(candidates: string[], blocks: Block[], limit = 4): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const found = verifyQuote(candidate, blocks);
    if (!found) continue;
    const key = found.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(found);
    if (out.length >= limit) break;
  }
  return out;
}

/** Every separately-quotable run of text in a block. */
function textsOf(block: Block): string[] {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
      return [block.text];
    case "list":
      // Per item, so a quote cannot span two bullets either.
      return block.items.map((item) => item.text);
    default:
      return [];
  }
}

/* --- regurgitation --------------------------------------------------------- */

/** Longer than this, verbatim, and the model is quoting rather than critiquing. */
const MAX_VERBATIM_WORDS = 12;

/**
 * Whether a finding simply repeats the draft back.
 *
 * The system instruction asks for at most twelve consecutive words. This
 * enforces it, because a finding that hands the author their own paragraph
 * back labelled as insight is worse than no finding — it looks like the
 * feature is working when it is not.
 */
export function isRegurgitation(finding: string, draftText: string): boolean {
  const words = normalise(finding).text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length <= MAX_VERBATIM_WORDS) return false;

  const haystack = normalise(draftText).text.toLowerCase();
  for (let i = 0; i + MAX_VERBATIM_WORDS < words.length + 1; i += 1) {
    const window = words.slice(i, i + MAX_VERBATIM_WORDS + 1).join(" ");
    if (window.split(" ").length <= MAX_VERBATIM_WORDS) break;
    if (haystack.includes(window)) return true;
  }
  return false;
}

/* --- tags and series -------------------------------------------------------- */

export type TagVocabularyEntry = { name: string; slug: string };

export type ResolvedTags = {
  /** Tags already in the vocabulary, by display name. */
  existing: string[];
  /** Genuinely new ones, by display name. */
  fresh: string[];
};

/**
 * Keeps the tag vocabulary from exploding.
 *
 * Three layers, and the third is the one that does the work: a proposed new
 * tag is run through `slugify` — the blog's own definition of tag identity,
 * per `normalizeTagNames` in src/lib/tags.ts — and if the slug collides with
 * an existing tag it is **folded into that tag** rather than creating a
 * second. That is how "Web Design" proposed against an existing "web-design"
 * becomes a reuse rather than a duplicate.
 */
export function resolveTags(
  suggested: { existing: string[]; fresh: string[] },
  vocabulary: TagVocabularyEntry[],
  alreadyOnPost: string[],
  limit = 5,
): ResolvedTags {
  const bySlug = new Map(vocabulary.map((tag) => [tag.slug, tag.name]));
  const onPost = new Set(alreadyOnPost.map((name) => slugify(name)));

  const existing: string[] = [];
  const fresh: string[] = [];
  const seen = new Set<string>();

  const take = (name: string, into: "existing" | "fresh") => {
    const slug = slugify(name);
    if (slug === "" || seen.has(slug) || onPost.has(slug)) return;
    if (existing.length + fresh.length >= limit) return;
    seen.add(slug);

    const known = bySlug.get(slug);
    if (known) existing.push(known);
    else if (into === "fresh") fresh.push(name.trim());
  };

  // Existing first, so the cap is spent on reuse before invention.
  for (const name of suggested.existing) take(name, "existing");
  for (const name of suggested.fresh) take(name, "fresh");

  return { existing, fresh };
}

/**
 * A series suggestion is only ever an existing series, or nothing.
 *
 * There is no code path anywhere that creates a series from a model's output.
 */
export function resolveSeries(
  suggested: string | null | undefined,
  available: { id: string; slug: string; title: string }[],
): { id: string; title: string } | null {
  if (!suggested || suggested === "none") return null;
  const found = available.find((entry) => entry.slug === suggested);
  return found ? { id: found.id, title: found.title } : null;
}

/* --- plain text bounds ------------------------------------------------------ */

/** Trims, drops empties, drops over-length rather than truncating mid-sentence. */
export function boundedStrings(
  values: unknown,
  options: { max: number; min?: number; limit: number; reject?: (value: string) => boolean },
): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value.length < (options.min ?? 1) || value.length > options.max) continue;
    if (options.reject?.(value)) continue;

    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= options.limit) break;
  }
  return out;
}

/* --- the cover brief -------------------------------------------------------- */

/*
  The brief is the only part of a post's content that reaches the image model,
  and post content is not fully trusted: `/api/import` accepts arbitrary .docx.
  A document containing "render this in blue with the word HOPE" must not be
  able to steer the house style, so anything naming a colour, a medium or a
  style is stripped here — after the schema has already denied it a field to
  put them in.
*/
const FORBIDDEN_IN_BRIEF =
  /\b(colou?r|colou?red|black|white|orange|red|blue|green|yellow|purple|pink|brown|grey|gray|golden|silver|monochrome|sepia|pastel|neon|vibrant|photo|photograph|photorealistic|realistic|3d|render|rendered|cgi|gradient|watercolou?r|oil painting|sketch|logo|text|typography|font|letter|lettering|word|caption|watermark|signature|banner)\b/i;

export type CoverBrief = { subject: string; human: string; avoid: string[] };

/**
 * Sanitises a stage-one brief, or rejects it.
 *
 * A tampered `subject` is a hard failure rather than something to clean up:
 * an image generation costs real money and takes twenty seconds, and spending
 * both on a prompt that has been steered is worse than saying no.
 */
export function verifyCoverBrief(raw: {
  subject?: unknown;
  human_element?: unknown;
  avoid?: unknown;
}): CoverBrief | null {
  const subject = typeof raw.subject === "string" ? raw.subject.trim() : "";
  const human = typeof raw.human_element === "string" ? raw.human_element.trim() : "";

  if (subject.length < 8 || subject.length > 300) return null;
  if (FORBIDDEN_IN_BRIEF.test(subject)) return null;

  return {
    subject,
    // A tampered human element is dropped rather than fatal: the style
    // template already insists on a figure, so an empty one degrades to the
    // house default instead of losing the generation.
    human: human.length >= 3 && human.length <= 120 && !FORBIDDEN_IN_BRIEF.test(human) ? human : "",
    avoid: boundedStrings(raw.avoid, { max: 60, limit: 4 }).filter(
      (entry) => !FORBIDDEN_IN_BRIEF.test(entry),
    ),
  };
}

/** Every word of a document, for the regurgitation check. */
export function draftText(blocks: Block[]): string {
  return blocks.flatMap(textsOf).join(" ");
}
