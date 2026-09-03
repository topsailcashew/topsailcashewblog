"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MEDIA_ROLES, type MediaRole } from "@/db/schema";
import type { UploadedMedia } from "@/lib/media";

export type ImageDetails = {
  role: MediaRole;
  altText: string;
  longDescription: string;
};

/**
 * Asks what an image is *for* before it goes into a post.
 *
 * Alt text is not a description field — it is a function of the image's role,
 * and the four roles have genuinely different rules. Asking "describe this
 * image" produces alt text on decorative rules and empty alt on charts;
 * asking "what is this doing here" produces neither.
 *
 * Built on the native `<dialog>` element, so the modal behaviour — the top
 * layer, the backdrop, Escape to close, and focus trapped inside — comes from
 * the platform rather than from a focus-trap library that has to be kept
 * correct by hand.
 */
export function ImageDetailsDialog(props: {
  /** Null renders nothing. */
  media: UploadedMedia | null;
  onCancel: () => void;
  onConfirm: (details: ImageDetails) => void;
}) {
  // Keyed on the image, so each one gets a fresh dialog with its own initial
  // state. Resetting the fields from an effect instead would re-render every
  // time the queue advanced, and would leave the previous image's alt text on
  // screen for a frame.
  if (!props.media) return null;
  return <Dialog key={props.media.id} {...props} media={props.media} />;
}

function Dialog({
  media,
  onCancel,
  onConfirm,
}: {
  media: UploadedMedia;
  onCancel: () => void;
  onConfirm: (details: ImageDetails) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const [role, setRole] = useState<MediaRole>("informative");
  const [altText, setAltText] = useState(media.alt_text ?? "");
  const [longDescription, setLongDescription] = useState(media.long_description ?? "");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;

    dialog.showModal();
    /*
      Focus is moved deliberately rather than left to the browser. `<dialog>`
      focuses its first tabbable child, which here is the role radio — the
      right target, but saying so means the dialog cannot silently start
      focusing a Cancel button if the markup is reordered later.
    */
    firstFieldRef.current?.focus();
  }, []);

  const confirm = useCallback(() => {
    onConfirm({
      role,
      // Decorative images carry no text at all. Storing something a screen
      // reader is instructed to skip is two answers to the same question.
      altText: role === "decorative" ? "" : altText.trim(),
      longDescription: role === "complex" ? longDescription.trim() : "",
    });
  }, [altText, longDescription, onConfirm, role]);

  const needsAlt = role !== "decorative";
  const missingAlt = needsAlt && altText.trim() === "";

  return (
    <dialog
      ref={dialogRef}
      className="image-dialog"
      aria-labelledby="image-dialog-title"
      // Escape closes the dialog natively; the state has to follow it.
      onClose={onCancel}
      onCancel={onCancel}
    >
      <form
        method="dialog"
        className="image-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <h2 id="image-dialog-title" className="image-dialog-title">
          What is this image for?
        </h2>

        <div className="image-dialog-layout">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="image-dialog-preview"
            src={media.lqip ?? media.url}
            alt=""
            width={media.width ?? undefined}
            height={media.height ?? undefined}
          />

          <div className="image-dialog-fields">
            <fieldset className="role-picker">
              <legend className="field-label">Role</legend>
              {MEDIA_ROLES.map((option, index) => (
                <label key={option} className="role-option">
                  <input
                    ref={index === 0 ? firstFieldRef : undefined}
                    type="radio"
                    name="image-role"
                    value={option}
                    checked={role === option}
                    onChange={() => setRole(option)}
                  />
                  <span>
                    <span className="role-name">{ROLE_LABELS[option].name}</span>
                    <span className="role-note">{ROLE_LABELS[option].note}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {needsAlt && (
              <label>
                {role === "functional" ? "What does it do?" : "Alt text"}
                <textarea
                  rows={2}
                  value={altText}
                  placeholder={
                    role === "functional"
                      ? "Search, Subscribe, Open the archive…"
                      : "What a reader who cannot see it would need to know."
                  }
                  onChange={(event) => setAltText(event.target.value)}
                />
              </label>
            )}

            {role === "complex" && (
              <label>
                Long description
                <textarea
                  rows={4}
                  value={longDescription}
                  placeholder="The figures, the trend, the thing the chart is evidence for."
                  onChange={(event) => setLongDescription(event.target.value)}
                />
              </label>
            )}

            {role === "decorative" && (
              <p className="hint">
                This will be inserted with <code>alt=&quot;&quot;</code>, so screen
                readers skip it entirely. Right for a rule, a texture, or a photo
                the surrounding text already describes.
              </p>
            )}

            {missingAlt && (
              <p className="hint hint--warn">
                Without alt text a screen reader announces the filename. Mark it
                decorative instead if it carries no meaning.
              </p>
            )}
          </div>
        </div>

        <div className="image-dialog-actions">
          <button type="button" className="btn btn--quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary">
            Insert
          </button>
        </div>
      </form>
    </dialog>
  );
}

const ROLE_LABELS: Record<MediaRole, { name: string; note: string }> = {
  informative: { name: "Informative", note: "Carries meaning the text does not" },
  decorative: { name: "Decorative", note: "Adds nothing — screen readers skip it" },
  functional: { name: "Functional", note: "Acts as a link or a button" },
  complex: { name: "Complex", note: "A chart or diagram needing a longer account" },
};
