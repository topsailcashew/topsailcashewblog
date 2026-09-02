"use client";

import { useState } from "react";
import { siteConfig, siteUrl } from "@/lib/site";

/**
 * Per-post SEO overrides, with a preview of the result.
 *
 * Every field is an override with a derived fallback, and the preview shows
 * the *effective* value — so leaving everything blank is a valid, visible
 * choice rather than a blank panel that looks unfinished.
 *
 * The character counts are guidance, not validation. Google truncates around
 * 60 and 155 characters, but it also rewrites titles at will, so a longer one
 * is a judgement call rather than an error.
 */
export type SeoFields = {
  metaTitle: string;
  metaDescription: string;
  canonicalUrl: string;
  noindex: boolean;
  ogImageUrl: string;
};

const TITLE_TARGET = 60;
const DESCRIPTION_TARGET = 155;

export function SeoPanel({
  fields,
  fallbackTitle,
  fallbackDescription,
  slug,
  onChange,
  onCommit,
}: {
  fields: SeoFields;
  fallbackTitle: string;
  fallbackDescription: string;
  slug: string;
  onChange: <K extends keyof SeoFields>(key: K, value: SeoFields[K]) => void;
  onCommit: () => void;
}) {
  const [open, setOpen] = useState(false);

  const effectiveTitle = fields.metaTitle.trim() || fallbackTitle || "Untitled";
  const effectiveDescription =
    fields.metaDescription.trim() || fallbackDescription || siteConfig.description;
  const origin = siteUrl() || "https://example.com";

  return (
    <div className="field seo-panel">
      <button
        type="button"
        className="btn btn--quiet btn--small"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? "Hide SEO" : "SEO"}
        {(fields.noindex || fields.canonicalUrl.trim() !== "") && (
          <span className="seo-flag" aria-hidden="true">
            •
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="seo-preview" aria-label="Search result preview">
            <span className="seo-preview-url">
              {origin.replace(/^https?:\/\//, "")}/{slug || "…"}
            </span>
            <span className="seo-preview-title">{truncate(effectiveTitle, 65)}</span>
            <span className="seo-preview-description">
              {truncate(effectiveDescription, 165)}
            </span>
          </div>

          <label>
            Meta title
            <input
              value={fields.metaTitle}
              placeholder={fallbackTitle || "Uses the post title"}
              onChange={(event) => onChange("metaTitle", event.target.value)}
              onBlur={onCommit}
            />
          </label>
          <Counter value={fields.metaTitle} target={TITLE_TARGET} />

          <label>
            Meta description
            <textarea
              rows={3}
              value={fields.metaDescription}
              placeholder={fallbackDescription || "Uses the excerpt"}
              onChange={(event) => onChange("metaDescription", event.target.value)}
              onBlur={onCommit}
            />
          </label>
          <Counter value={fields.metaDescription} target={DESCRIPTION_TARGET} />

          <label>
            Canonical URL
            <input
              type="url"
              value={fields.canonicalUrl}
              placeholder="Only if this was published elsewhere first"
              onChange={(event) => onChange("canonicalUrl", event.target.value)}
              onBlur={onCommit}
            />
          </label>
          <p className="hint">
            Points search engines at the original when this post is a
            republication. Leave empty otherwise.
          </p>

          <label>
            Social image URL
            <input
              value={fields.ogImageUrl}
              placeholder="Falls back to the cover, then a generated card"
              onChange={(event) => onChange("ogImageUrl", event.target.value)}
              onBlur={onCommit}
            />
          </label>

          <label className="seo-checkbox">
            <input
              type="checkbox"
              checked={fields.noindex}
              onChange={(event) => {
                onChange("noindex", event.target.checked);
                onCommit();
              }}
            />
            Hide from search engines
          </label>
          <p className="hint">
            Keeps the post live and linkable but out of search results. It is
            also dropped from the sitemap — listing a URL while telling
            crawlers to ignore it is reported as an error.
          </p>
        </>
      )}
    </div>
  );
}

function Counter({ value, target }: { value: string; target: number }) {
  const length = value.trim().length;
  if (length === 0) return null;
  return (
    <p className={length > target ? "hint hint--warn" : "hint"}>
      {length} / {target} characters
      {length > target && " — likely to be truncated"}
    </p>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
