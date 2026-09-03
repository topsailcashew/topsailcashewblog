import type { MediaRole } from "@/db/schema";

/**
 * The alt text an image should actually render with.
 *
 * The whole reason `media.role` is stored: a decorative image must emit
 * `alt=""`, and an empty string is not the same as a missing attribute.
 * Missing alt makes a screen reader announce the filename; `alt=""` makes it
 * skip the image entirely, which is the correct treatment for a rule, a
 * texture, or a portrait the surrounding prose has already described.
 *
 * In its own module, with no imports beyond a type, because both the server
 * (the dashboard's media strip) and the browser (the library, the editor) need
 * it. Re-exporting it from `media.ts` would drag Drizzle and the R2 binding
 * into the client bundle for the sake of six lines of arithmetic.
 */
export function altTextFor(item: {
  role?: MediaRole | null;
  alt_text?: string | null;
}): string {
  if (item.role === "decorative") return "";
  return item.alt_text ?? "";
}
