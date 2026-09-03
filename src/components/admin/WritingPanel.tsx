"use client";

import type { JSONContent } from "@tiptap/react";
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { toBlocks } from "@/lib/blocks";
import {
  gradeLabel,
  measure,
  type Level,
  type ProseMetrics,
} from "@/lib/prose-metrics";
import { EditorSection } from "./EditorSection";

/**
 * The Hemingway readout, and a structural read from Gemini.
 *
 * Two halves that answer different questions. The counts are arithmetic —
 * instant, free, exact, recomputed as you type, and correct whether or not an
 * API key exists. The structural read is judgement, which is the one thing a
 * model is actually better at here, and it costs a call so it happens on a
 * button press and never on its own.
 *
 * The collapsed summary is the feature. `grade 9 · 3 hard · 2 adverbs` sits in
 * the sidebar the whole time you are writing, which is what makes this a
 * readability meter rather than a report you have to go and ask for.
 */

export type Analysis = {
  shape: { heading: string; does: string; verdict: string }[];
  opening: { verdict: string; note: string };
  ending: { verdict: string; note: string };
  strengths: { claim: string; where: string | null }[];
  weaknesses: {
    problem: string;
    where: string | null;
    fix: string;
    severity: "blocking" | "worth_fixing" | "minor";
  }[];
  one_thing: string;
};

export function WritingPanel({
  postId,
  contentJson,
  aiReady,
  highlight,
  onHighlightChange,
  onBeforeRun,
}: {
  postId: string | null;
  contentJson: JSONContent;
  /** False when no Gemini key is configured — only the model half is blocked. */
  aiReady: boolean;
  highlight: boolean;
  onHighlightChange: (on: boolean) => void;
  /** Flushes the autosave, so the server reads the current draft. */
  onBeforeRun: () => Promise<unknown>;
}) {
  /*
    Deferred, so measuring never lands on the typing path. `measure` costs a
    few milliseconds on a long post; React renders the keystroke first and the
    numbers a beat later, which is exactly the trade you want.
  */
  const deferred = useDeferredValue(contentJson);
  const metrics = useMemo(() => measure(toBlocks(deferred)), [deferred]);

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The document as it was when the analysis was run, to spot drift. */
  const [analysedWords, setAnalysedWords] = useState<number | null>(null);

  const run = useCallback(async () => {
    if (!postId) return;
    setBusy(true);
    setError(null);
    try {
      await onBeforeRun();
      const response = await fetch(`/api/posts/${postId}/analysis`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        analysis?: Analysis;
      };
      if (!response.ok || !body.analysis) {
        throw new Error(body.error ?? `Could not analyse (${response.status})`);
      }
      setAnalysis(body.analysis);
      setAnalysedWords(metrics.words);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not analyse");
    } finally {
      setBusy(false);
    }
  }, [metrics.words, onBeforeRun, postId]);

  const stale = analysedWords !== null && Math.abs(metrics.words - analysedWords) > 20;

  return (
    <EditorSection title="Writing" summary={summaryOf(metrics)}>
      <div className="writing-panel">
        {metrics.words === 0 ? (
          <p className="hint">Nothing to measure yet.</p>
        ) : (
          <>
            <dl className="metric-list">
              <Metric
                label="Hard sentences"
                value={metrics.hard + metrics.veryHard}
                note={
                  metrics.veryHard > 0 ? `${metrics.veryHard} very hard` : "over 18 words"
                }
                over={metrics.hard + metrics.veryHard > Math.ceil(metrics.sentences / 4)}
              />
              <Metric
                label="Adverbs"
                value={metrics.adverbs}
                note={`budget ${metrics.budgets.adverbs}`}
                over={metrics.adverbs > metrics.budgets.adverbs}
              />
              <Metric
                label="Passive voice"
                value={metrics.passive}
                note={`budget ${metrics.budgets.passive}`}
                over={metrics.passive > metrics.budgets.passive}
              />
              <Metric
                label="Wordy phrases"
                value={metrics.wordy}
                note={metrics.wordy > 0 ? "shorter forms exist" : "none"}
                over={metrics.wordy > 0}
              />
              <Metric
                label="Reading grade"
                value={metrics.grade}
                note={gradeLabel(metrics.grade)}
                over={metrics.grade > 12}
              />
            </dl>

            <p className="hint">
              {metrics.words} words · {metrics.sentences} sentences ·{" "}
              {metrics.readingMinutes} min read
            </p>

            <label className="check-row">
              <input
                type="checkbox"
                checked={highlight}
                onChange={(event) => onHighlightChange(event.target.checked)}
              />
              Highlight in the text
            </label>

            {metrics.worst.length > 0 && (
              <div className="worst-list">
                <span className="field-label">Longest sentences</span>
                <ol>
                  {metrics.worst.map((sentence, index) => (
                    <li key={`${sentence.blockId}-${index}`}>
                      <span className={`sentence-level sentence-level--${sentence.level}`}>
                        {sentence.words}
                      </span>
                      <span className="worst-text">{truncate(sentence.text, 90)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}

        <hr className="panel-rule" />

        {!postId ? (
          <p className="hint">Save the post before asking for a read.</p>
        ) : !aiReady ? (
          <p className="hint">
            The counts above need nothing. A structural read needs a Gemini key
            — <Link href="/admin/settings">add one in Settings →</Link>
          </p>
        ) : (
          <button
            type="button"
            className="btn btn--small"
            disabled={busy || metrics.words < 50}
            onClick={() => void run()}
            title={metrics.words < 50 ? "Write a little more first" : undefined}
          >
            {busy ? "Reading…" : analysis ? "Read it again" : "Ask for a structural read"}
          </button>
        )}

        {stale && analysis && (
          <p className="hint hint--warn">
            The draft has changed since this was written. Ask again for a
            current read.
          </p>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {analysis && <AnalysisReport analysis={analysis} />}
      </div>
    </EditorSection>
  );
}

function AnalysisReport({ analysis }: { analysis: Analysis }) {
  return (
    <div className="analysis">
      <p className="analysis-one-thing">
        <span className="label">The one thing</span>
        {analysis.one_thing}
      </p>

      <Verdict label="Opening" verdict={analysis.opening.verdict} note={analysis.opening.note} />
      <Verdict label="Ending" verdict={analysis.ending.verdict} note={analysis.ending.note} />

      {analysis.weaknesses.length > 0 && (
        <div className="analysis-group">
          <span className="field-label">Worth fixing</span>
          <ul className="analysis-list">
            {analysis.weaknesses.map((item) => (
              <li key={item.problem} className={`severity--${item.severity}`}>
                <span className="analysis-problem">{item.problem}</span>
                {item.where && <span className="analysis-where">{item.where}</span>}
                <span className="analysis-fix">{item.fix}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.strengths.length > 0 && (
        <div className="analysis-group">
          <span className="field-label">Working</span>
          <ul className="analysis-list">
            {analysis.strengths.map((item) => (
              <li key={item.claim}>
                <span className="analysis-problem">{item.claim}</span>
                {item.where && <span className="analysis-where">{item.where}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.shape.length > 0 && (
        <div className="analysis-group">
          <span className="field-label">Shape</span>
          <ol className="analysis-shape">
            {analysis.shape.map((section) => (
              <li key={section.heading} className={`verdict--${section.verdict}`}>
                <span className="analysis-problem">{section.heading}</span>
                <span className="analysis-where">{section.does}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Verdict({
  label,
  verdict,
  note,
}: {
  label: string;
  verdict: string;
  note: string;
}) {
  return (
    <p className="analysis-verdict">
      <span className="label">{label}</span>
      <span className="analysis-verdict-value">{verdict.replace(/_/g, " ")}</span>
      <span className="analysis-where">{note}</span>
    </p>
  );
}

function Metric({
  label,
  value,
  note,
  over,
}: {
  label: string;
  value: number;
  note: string;
  over: boolean;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={over ? "metric-value is-over" : "metric-value"}>
        {value}
        <span className="metric-note">{note}</span>
      </dd>
    </>
  );
}

/**
 * The collapsed header.
 *
 * Only the numbers that would make you change something. A word count on a
 * closed panel is furniture; "3 hard" is a reason to open it.
 */
function summaryOf(metrics: ProseMetrics): string | undefined {
  if (metrics.words === 0) return undefined;

  const parts = [`grade ${metrics.grade}`];
  const hard = metrics.hard + metrics.veryHard;
  if (hard > 0) parts.push(`${hard} hard`);
  if (metrics.adverbs > metrics.budgets.adverbs) parts.push(`${metrics.adverbs} adverbs`);
  return parts.join(" · ");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

export type { Level };
