# Build-time assets

`noto-serif-*.ttf` — Noto Serif (SIL Open Font License 1.1), used only by
`scripts/generate-og-images.ts` when rasterising social cards during the build.

These files never reach the Worker bundle or the browser. satori has no access
to CSS or system fonts, so the font has to be handed to it as bytes; committing
it keeps the build self-contained and offline-capable.
