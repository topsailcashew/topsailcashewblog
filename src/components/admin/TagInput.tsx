"use client";

import { useState } from "react";

/**
 * Tags are plain names. The API upserts them by slug, so "Web Design" and
 * "web design" resolve to the same tag — dedupe here on the same basis to
 * avoid showing what looks like a duplicate chip.
 */
export function TagInput({
  tags,
  onChange,
  disabled,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  function add(raw: string) {
    const name = raw.trim();
    if (!name) return;
    const exists = tags.some((tag) => normalize(tag) === normalize(name));
    if (!exists) onChange([...tags, name]);
    setDraft("");
  }

  function remove(index: number) {
    onChange(tags.filter((_, i) => i !== index));
  }

  return (
    <div className="tag-input">
      <div className="row">
        {tags.map((tag, index) => (
          <span key={`${tag}-${index}`} className="tag-pill tag-chip">
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => remove(index)}
              disabled={disabled}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        aria-label="Add a tag"
        placeholder="Add a tag and press Enter"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add(draft);
          } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
            remove(tags.length - 1);
          }
        }}
        onBlur={() => add(draft)}
      />
    </div>
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
