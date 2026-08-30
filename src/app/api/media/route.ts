import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { ApiError, handle, json } from "@/lib/http";
import { listMedia, uploadMedia } from "@/lib/media";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { getMediaBucket } from "@/lib/r2";

export const dynamic = "force-dynamic";

/** POST /api/media — multipart upload of a single image. */
export const POST = handle(async (request: NextRequest) => {
  // Checked before parsing: an over-sized body gets truncated upstream, and the
  // resulting parse failure would otherwise surface as a baffling 400.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      `Upload is ${(declaredLength / (1024 * 1024)).toFixed(1)} MB; the limit is ${
        MAX_UPLOAD_BYTES / (1024 * 1024)
      } MB`,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError(400, "Expected a multipart/form-data body");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ApiError(422, "Missing `file` field");
  }

  const altValue = form.get("alt_text");
  const altText = typeof altValue === "string" && altValue.trim() !== ""
    ? altValue.trim()
    : null;

  const uploaded = await uploadMedia(getDb(), await getMediaBucket(), file, altText);
  return json({ media: uploaded }, 201);
});

/** GET /api/media — recent uploads, newest first. */
export const GET = handle(async () => {
  return json({ media: await listMedia(getDb()) });
});
