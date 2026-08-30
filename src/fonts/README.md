# Vendored webfonts

Anton, Inter and Source Serif 4 — all SIL Open Font License 1.1 — extracted
from the `@fontsource/*` packages and committed here.

They are loaded through `next/font/local`, not `next/font/google`, so the build
never reaches out to fonts.googleapis.com. That loader fetches at build time,
which means a machine or CI runner that cannot reach Google fails the build
outright rather than degrading. Vendoring the eight files (180 KB total) makes
the build hermetic.

Latin subsets only. To add a weight, copy it from the matching
`node_modules/@fontsource/*/files/` and register it in `src/app/layout.tsx`.
