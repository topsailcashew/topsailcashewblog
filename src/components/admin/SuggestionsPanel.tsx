"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { EditorSection } from "./EditorSection";

/**
 * Titles, excerpt, tags, series, keywords and pull-quotes — one call, one panel.
 *
 * **Nothing is pre-selected and nothing applies itself.** Every item is a chip
 * or a row that does nothing until it is clicked. That matters most for
 * titles: a generated title that quietly replaced a hand-written one would
 * poison the author's trust in every other panel here.
 */

export type Suggestions = {
  titles: string[];
  excerpt: string | null;
  meta_description: string | null;
  tags: { existing: string[]; fresh: string[] };
  series: { id: string; title: string } | null;
  keywords: string[];
  quotes: string[];
};

export type SuggestionPatch = {
  title?: string;
  excerpt?: string;
  metaDescription?: string;
  addTags?: string[];
  seriesId?: string;
};

export function SuggestionsPanel({
  postId,
  aiReady,
  currentTitle,
  onApply,
  onInsertQuote,
  onBeforeRun,
}: {
  postId: string | null;
  aiReady: boolean;
  currentTitle: string;
  onApply: (patch: SuggestionPatch) => void;
  onInsertQuote: (quote: string) => void;
  onBeforeRun: () => Promise<unknown>;
}) {
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!postId) return;
    setBusy(true);
    setError(null);
    try {
      await onBeforeRun();
      const response = await fetch(`/api/posts/${postId}/suggest`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        suggestions?: Suggestions;
      };
      if (!response.ok || !body.suggestions) {
        throw new Error(body.error ?? `Could not suggest (${response.status})`);
      }
      setSuggestions(body.suggestions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not suggest");
    } finally {
      setBusy(false);
    }
  }, [onBeforeRun, postId]);

  const copy = useCallback(async (quote: string) => {
    try {
      await navigator.clipboard?.writeText(quote);
      setCopied(quote);
    } catch {
      // Clipboard access can be refused; the text is on screen to copy by hand.
    }
  }, []);

  const allTags = suggestions
    ? [...suggestions.tags.existing, ...suggestions.tags.fresh]
    : [];

  return (
    <EditorSection title="Suggestions" summary={summaryOf(suggestions, aiReady)}>
      <div className="suggestions-panel">
        {!postId ? (
          <p className="hint">Save the post first.</p>
        ) : !aiReady ? (
          <p className="hint">
            Needs a Gemini key. <Link href="/admin/settings">Settings →</Link>
          </p>
        ) : (
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? "Reading…" : suggestions ? "Suggest again" : "Suggest"}
          </button>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {suggestions && (
          <>
            {suggestions.titles.length > 0 && (
              <div className="suggest-group">
                <span className="field-label">Titles</span>
                <p className="hint suggest-current">Now: {currentTitle || "Untitled"}</p>
                <ul className="suggest-list">
                  {suggestions.titles.map((title) => (
                    <li key={title}>
                      <button
                        type="button"
                        className="suggest-apply"
                        onClick={() => onApply({ title })}
                      >
                        {title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {suggestions.excerpt && (
              <div className="suggest-group">
                <span className="field-label">Excerpt</span>
                <button
                  type="button"
                  className="suggest-apply"
                  onClick={() => onApply({ excerpt: suggestions.excerpt! })}
                >
                  {suggestions.excerpt}
                </button>
              </div>
            )}

            {suggestions.meta_description && (
              <div className="suggest-group">
                <span className="field-label">Meta description</span>
                <button
                  type="button"
                  className="suggest-apply"
                  onClick={() =>
                    onApply({ metaDescription: suggestions.meta_description! })
                  }
                >
                  {suggestions.meta_description}
                </button>
              </div>
            )}

            {allTags.length > 0 && (
              <div className="suggest-group">
                <span className="field-label">Tags</span>
                <div className="suggest-chips">
                  {suggestions.tags.existing.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="tag-pill"
                      onClick={() => onApply({ addTags: [tag] })}
                    >
                      {tag}
                    </button>
                  ))}
                  {suggestions.tags.fresh.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="tag-pill tag-pill--new"
                      onClick={() => onApply({ addTags: [tag] })}
                      title="Not used anywhere yet"
                    >
                      {tag} <span className="pill-count">new</span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn--quiet btn--small"
                  onClick={() => onApply({ addTags: allTags })}
                >
                  Add all
                </button>
              </div>
            )}

            {suggestions.series && (
              <div className="suggest-group">
                <span className="field-label">Series — a guess</span>
                <button
                  type="button"
                  className="suggest-apply"
                  onClick={() => onApply({ seriesId: suggestions.series!.id })}
                >
                  {suggestions.series.title}
                </button>
              </div>
            )}

            {suggestions.quotes.length > 0 && (
              <div className="suggest-group">
                <span className="field-label">Pull-quotes</span>
                <p className="hint">
                  Checked word for word against the draft. For the newsletter or
                  a fediverse post — inserting one puts the same sentence in the
                  piece twice.
                </p>
                <ul className="suggest-quotes">
                  {suggestions.quotes.map((quote) => (
                    <li key={quote}>
                      <blockquote>{quote}</blockquote>
                      <span className="row row--tight">
                        <button
                          type="button"
                          className="btn btn--quiet btn--small"
                          onClick={() => void copy(quote)}
                        >
                          {copied === quote ? "Copied" : "Copy"}
                        </button>
                        <button
                          type="button"
                          className="btn btn--quiet btn--small"
                          onClick={() => onInsertQuote(quote)}
                        >
                          Insert as blockquote
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {suggestions.keywords.length > 0 && (
              <div className="suggest-group">
                <span className="field-label">Would rank for</span>
                {/*
                  Read-only on purpose. There is no meta_keywords column and
                  there should not be one — Google stopped reading that tag in
                  2009. These are guidance for writing the description by hand.
                */}
                <p className="suggest-keywords">{suggestions.keywords.join(" · ")}</p>
              </div>
            )}
          </>
        )}
      </div>
    </EditorSection>
  );
}

function summaryOf(suggestions: Suggestions | null, aiReady: boolean): string | undefined {
  if (!aiReady) return "no key";
  if (!suggestions) return undefined;
  const count =
    suggestions.titles.length +
    suggestions.tags.existing.length +
    suggestions.tags.fresh.length +
    suggestions.quotes.length;
  return count > 0 ? `${count} to review` : "nothing to add";
}
