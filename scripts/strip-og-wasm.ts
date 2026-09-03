/**
 * Removes the OG-image WebAssembly from the proxy bundle.
 *
 * ## What this is fixing
 *
 * Next puts `next/og` — Satori plus resvg, as two WebAssembly modules — into
 * the proxy bundle unconditionally. Nothing in this app renders an image at
 * request time: the social cards are rendered at build time by
 * `scripts/generate-og-images.ts` into `public/og/`, precisely because a Worker
 * is the wrong place to do it. The proxy itself is forty lines of cookie
 * checking.
 *
 * So the two modules are dead weight — and expensive dead weight. They are
 * 545 KiB *gzipped*, against Cloudflare's hard 3 MiB limit on a Worker. That
 * is a sixth of the entire budget spent on code that cannot run.
 *
 * There is no supported way to opt out (checked against the Next docs bundled
 * in node_modules), so the imports are replaced after the build with stubs
 * that throw if anything ever does reach for them. That failure mode is the
 * point: it is loud and it names itself, rather than a null dereference three
 * frames deep in Satori.
 *
 * If a future Next stops emitting these, the anchors will not match and this
 * reports that it found nothing — a no-op, not a failure.
 */
import { readFile, writeFile } from "node:fs/promises";

const TARGET = ".open-next/middleware/handler.mjs";

/** Matches `import yoga_wasm from ".../yoga.wasm?module";` whatever the path. */
const IMPORT = /import\s+([A-Za-z_$][\w$]*)\s+from\s+"[^"]*\/(yoga|resvg)\.wasm\?module";?/g;

async function main(): Promise<void> {
  let source: string;
  try {
    source = await readFile(TARGET, "utf8");
  } catch {
    console.log(`strip-og-wasm: ${TARGET} not found — nothing to do.`);
    return;
  }

  const found: string[] = [];
  const stripped = source.replace(IMPORT, (_match, binding: string, name: string) => {
    found.push(name);
    /*
      A getter rather than `null`. Reaching for it then throws something that
      says what happened and what to do about it, instead of "cannot read
      properties of null" from inside a minified vendor bundle.
    */
    return `const ${binding} = new Proxy({}, { get() { throw new Error("next/og is not available in this Worker: the OG wasm is stripped at build time by scripts/strip-og-wasm.ts. Social cards are pre-rendered into public/og by scripts/generate-og-images.ts."); } });`;
  });

  if (found.length === 0) {
    console.log("strip-og-wasm: no OG wasm imports found — nothing to strip.");
    return;
  }

  await writeFile(TARGET, stripped);
  console.log(
    `strip-og-wasm: stubbed ${found.join(" and ")} in the proxy bundle (~545 KiB gzipped).`,
  );
}

main().catch((error) => {
  console.error("strip-og-wasm failed:", error);
  process.exit(1);
});
