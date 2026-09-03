"use client";

import { useCallback, useState } from "react";
import { uploadImage } from "@/lib/upload-client";

/**
 * Generates a cover, previews it, and only then uploads it.
 *
 * Nothing is destructive until "Use this cover": an existing cover is
 * untouched, and a rejected generation leaves no R2 object and no `media` row
 * behind — which is the whole reason the route returns bytes rather than
 * writing them itself.
 *
 * The brief is editable and "Try again" re-runs only the image. That is
 * cheaper and faster than a fresh brief, and it is the difference between a
 * steering wheel and a slot machine.
 */

type Brief = { subject: string; human: string; avoid: string[] };

type Generated = { brief: Brief; dataUrl: string };

export function CoverGenerator({
  postId,
  postSlug,
  onAccept,
  onCancel,
  onBeforeRun,
}: {
  postId: string;
  postSlug: string;
  onAccept: (url: string) => void;
  onCancel: () => void;
  onBeforeRun: () => Promise<unknown>;
}) {
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState<"idle" | "generating" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(
    async (brief?: Brief) => {
      setBusy("generating");
      setError(null);
      try {
        // The server reads the saved draft, so flush first — the same idiom
        // the preview button uses.
        if (!brief) await onBeforeRun();

        const response = await fetch(`/api/posts/${postId}/cover`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(brief ? { brief } : {}),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          brief?: Brief;
          mime_type?: string;
          data?: string;
        };
        if (!response.ok || !body.data || !body.brief) {
          throw new Error(body.error ?? `Could not generate (${response.status})`);
        }

        setGenerated({
          brief: body.brief,
          dataUrl: `data:${body.mime_type ?? "image/png"};base64,${body.data}`,
        });
        setSubject(body.brief.subject);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not generate");
      } finally {
        setBusy("idle");
      }
    },
    [onBeforeRun, postId],
  );

  const accept = useCallback(async () => {
    if (!generated) return;
    setBusy("saving");
    setError(null);
    try {
      const file = await dataUrlToFile(generated.dataUrl, `cover-${postSlug || "post"}.png`);
      const media = await uploadImage(file, {
        // The article renders a cover with alt="" (see Article.tsx), so
        // recording alt text on it would store two contradictory answers.
        role: "decorative",
      });
      onAccept(media.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the image");
      setBusy("idle");
    }
  }, [generated, onAccept, postSlug]);

  return (
    <div className="cover-generator">
      {!generated ? (
        <>
          <p className="hint">
            Reads the draft, picks a subject, and draws it in the house style —
            black, white and one orange, every time.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn--primary btn--small"
              disabled={busy !== "idle"}
              onClick={() => void generate()}
            >
              {busy === "generating" ? "Drawing… (up to a minute)" : "Generate a cover"}
            </button>
            <button type="button" className="btn btn--quiet btn--small" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="cover-preview" src={generated.dataUrl} alt="" />

          <label>
            Subject
            <textarea
              rows={2}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </label>
          <p className="hint">
            Edit this and try again to steer the picture. The palette and
            technique are fixed and are not part of the brief.
          </p>

          <div className="row">
            <button
              type="button"
              className="btn btn--primary btn--small"
              disabled={busy !== "idle"}
              onClick={() => void accept()}
            >
              {busy === "saving" ? "Saving…" : "Use this cover"}
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy !== "idle" || subject.trim().length < 8}
              onClick={() => void generate({ ...generated.brief, subject: subject.trim() })}
            >
              {busy === "generating" ? "Drawing…" : "Try again"}
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--small"
              disabled={busy !== "idle"}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Base64 to a `File`, so the existing upload path can take it.
 *
 * Going through `uploadImage` rather than a bespoke endpoint means the
 * generated cover gets a BlurHash and an LQIP like every other upload, and
 * appears in the media library looking identical to one.
 */
async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type || "image/png" });
}
