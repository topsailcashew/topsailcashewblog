import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { findFlags, gradeSentence, splitSentences } from "@/lib/prose-metrics";

/**
 * Hemingway's highlighting, in the editor itself.
 *
 * A stats box tells you the draft has three hard sentences. This tells you
 * that *this* one is, while the cursor is still in it — which is the
 * difference between fixing the sentence you are writing and the one you wrote
 * last week.
 *
 * ## Why the toggle is plugin state, not a conditional extension
 *
 * `PostEditor` builds its extension list inside `useMemo(() => …, [])`, and
 * its comment says why: rebuilding the list recreates the ProseMirror schema.
 * So the obvious implementation — include the extension when the box is
 * ticked — would reset the open document every time it was toggled. The
 * extension is therefore always present and dormant, and the switch is a flag
 * in plugin state flipped by a transaction.
 *
 * ## Why the decorations are recomputed rather than mapped
 *
 * A `DecorationSet` can be mapped forward through a transaction, which is
 * cheaper. It is also the source of every "the highlights drifted onto the
 * wrong words" bug, because a decoration's meaning here depends on the text it
 * covers, not on its position. Recomputing is O(document); the document is one
 * blog post.
 */

export const proseHighlightKey = new PluginKey<HighlightState>("proseHighlight");

type HighlightState = { enabled: boolean; decorations: DecorationSet };

/** Sent as transaction metadata to turn highlighting on or off. */
export type HighlightMeta = { enabled: boolean };

export const ProseHighlight = Extension.create({
  name: "proseHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightState>({
        key: proseHighlightKey,

        state: {
          init: () => ({ enabled: false, decorations: DecorationSet.empty }),

          apply(tr, previous) {
            const meta = tr.getMeta(proseHighlightKey) as HighlightMeta | undefined;
            const enabled = meta?.enabled ?? previous.enabled;

            if (!enabled) return { enabled, decorations: DecorationSet.empty };

            // Recompute on a real change, or when switching on. Otherwise the
            // previous set still describes the same text.
            if (!tr.docChanged && enabled === previous.enabled) return { ...previous, enabled };

            return { enabled, decorations: buildDecorations(tr.doc) };
          },
        },

        props: {
          decorations(state) {
            return proseHighlightKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

/**
 * Walks the document's text blocks and decorates sentences and flags.
 *
 * Positions are derived per block: a text block's content starts at
 * `pos + 1`, and `textBetween` with a single-character placeholder for inline
 * nodes keeps the offsets aligned — without it, every highlight after an
 * inline image would be shifted by the width of nothing.
 */
function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Code is not English; heading length is not a readability signal.
    if (node.type.name === "codeBlock" || node.type.name === "heading") return false;

    const text = node.textBetween(0, node.content.size, "\n", "￼");
    if (text.trim() === "") return false;

    const from = pos + 1;

    for (const sentence of splitSentences(text)) {
      const { level } = gradeSentence(sentence.text);
      if (level === "plain") continue;
      decorations.push(
        Decoration.inline(from + sentence.start, from + sentence.end, {
          class: `ph ph--${level === "very_hard" ? "very-hard" : "hard"}`,
        }),
      );
    }

    for (const flag of findFlags(text)) {
      decorations.push(
        Decoration.inline(from + flag.start, from + flag.end, {
          class: `ph ph--${flag.kind}`,
          ...(flag.hint ? { title: `Try "${flag.hint}"` } : {}),
        }),
      );
    }

    return false;
  });

  return DecorationSet.create(doc, decorations);
}

/** Flips the switch on a live editor. */
export function setProseHighlight(view: EditorView, enabled: boolean): void {
  view.dispatch(view.state.tr.setMeta(proseHighlightKey, { enabled } satisfies HighlightMeta));
}
