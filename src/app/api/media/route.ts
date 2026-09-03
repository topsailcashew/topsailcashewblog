import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { ApiError, handle, json } from "@/lib/http";
import { countMedia, listMedia, uploadMedia } from "@/lib/media";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { getMediaBucket } from "@/lib/r2";
import { imageMetadataSchema } from "@/lib/validation";
import { MEDIA_ROLES, type MediaRole } from "@/db/schema";

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

  const altText = text(form.get("alt_text"));
  const roleValue = text(form.get("role"));
  const role = MEDIA_ROLES.includes(roleValue as MediaRole)
    ? (roleValue as MediaRole)
    : undefined;

  /*
    Measurements the browser took. Parsed through the same schema as anything
    else a client sends: `lqip` in particular is inlined into pages, so an
    unbounded string here would be a way to stow a payload in every page an
    image appears on.
  */
  const metadataValue = text(form.get("metadata"));
  let client;
  if (metadataValue) {
    try {
      client = imageMetadataSchema.parse(JSON.parse(metadataValue));
    } catch {
      // Placeholders are a nicety. A malformed one is not worth failing an
      // upload the writer is waiting on.
      client = undefined;
    }
  }

  const uploaded = await uploadMedia(getDb(), await getMediaBucket(), file, altText, {
    role,
    longDescription: text(form.get("long_description")),
    client,
  });
  return json({ media: uploaded }, 201);
});

function text(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** GET /api/media — recent uploads, newest first. `?q=` searches, `?offset=`. */
export const GET = handle(async (request: NextRequest) => {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Number(params.get("limit") ?? 60) || 60, 200);
  const offset = Math.max(Number(params.get("offset") ?? 0) || 0, 0);
  const search = params.get("q") ?? undefined;

  const [items, total] = await Promise.all([
    listMedia(getDb(), limit, { search, offset }),
    countMedia(getDb()),
  ]);
  return json({ media: items, total });
});
