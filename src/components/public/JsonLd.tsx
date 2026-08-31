/**
 * Emits a JSON-LD block.
 *
 * The payload is produced by `src/lib/structured-data.ts` with JSON.stringify,
 * so it is valid JSON by construction; `<` is escaped so a title containing
 * "</script>" cannot close the tag early.
 */
export function JsonLd({ json }: { json: string }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: json.replace(/</g, "\\u003c") }}
    />
  );
}
