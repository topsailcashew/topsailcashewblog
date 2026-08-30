# Design.md — TOPSAILCASHEW

Visual and UX spec for the personal blog, adapted from an editorial/art-magazine reference (bold condensed hero type, black/white grid, gallery-style cards). Adapted for a single-author, long-form essay site rather than a busy visual magazine.

---

## 1. Core Aesthetic

Confident, editorial, black-and-white with one hot accent color. The type scale does the work: an enormous condensed wordmark contrasted against small, restrained utility text everywhere else. Cover images are treated as gallery pieces (grayscale/duotone) rather than full-color photography, keeping the whole UI feeling like one consistent object.

**Not** a soft, friendly "personal blog" look. **Not** a busy multi-color magazine. Think: gallery catalogue crossed with a masthead.

---

## 2. Color

| Token | Value | Usage |
|---|---|---|
| `--bg` | `#FFFFFF` | Page background |
| `--fg` | `#0A0A0A` | Primary text, hero type, borders |
| `--fg-muted` | `#6B6B6B` | Metadata (dates, reading time), secondary text |
| `--accent` | Orange (e.g. `#FF5A1F` — confirm exact hex during implementation, aim for a hot/saturated orange, not pastel) | Links, active tag pill, hover states, focus rings |
| `--border` | `#E5E5E5` | Hairline dividers between cards/sections |

No grayscale-canvas/black-page framing on inner pages (see §3). Homepage only.

Cover images: apply a grayscale or duotone filter (`--fg` shadows / `--bg` highlights) uniformly across all covers, so imagery reads as part of the same monochrome system as the UI, with the accent color living only in interface elements, never baked into images.

---

## 3. Page Framing

- **Homepage only:** white "page" floats on a black canvas, matching the reference — generous black margin around a centered white content area, small footer credit line at the bottom (e.g. site name + tagline, styled like the reference's `gola.io/FYRRE` tag).
- **Post pages, tag pages, admin:** standard white background, no black canvas framing. The framing device is a homepage signature, not a site-wide shell — keeps reading pages from feeling gimmicky over long-form text.

---

## 4. Typography

**Hero / display**
- Ultra-bold, condensed sans-serif (candidates to evaluate: Archivo Black, Anton, Neue Haas Grotesk Condensed Black, or similar — pick one with a true condensed-black cut, don't fake condensation via `letter-spacing` alone)
- Used for: the "TOPSAILCASHEW" homepage hero, and post titles at a smaller (but still bold) weight of the same family
- Tight tracking, tight leading — the reference's headline sits with almost no line-gap

**UI / metadata**
- Clean, restrained sans-serif (e.g. Inter, Söhne, or a system sans) for: nav, category pills, dates, reading time, tags, buttons, admin UI
- Small sizes are intentional — metadata should read as quiet, utilitarian credit-line text, not competing with content

**Body copy (post content)**
- Serif for the actual essay text (carried over from the Phase 3 plan) — this is the one deliberate departure from the reference, which is sans-serif throughout. The reference's DNA is in the *layout and hero type*, not in dictating body-copy font.
- Generous line-height (~1.6–1.8), ~680px max reading width, as previously specced

---

## 5. Homepage Layout

**Nav**
- Wordmark ("TOPSAILCASHEW") left, small text nav + minimal icon links right (e.g. RSS icon, social if any) — quiet, doesn't compete with hero below

**Hero**
- Full-width, huge condensed wordmark, dominates the top of the page the way "MAGAZINE" does in the reference

**Category filter row**
- "CATEGORIES" label (small, tracked-out caps) + pill-shaped tag filters: `ALL` plus one pill per tag in use
- Active pill filled with `--accent`; inactive pills outlined/ghost style
- Right-aligned or left-aligned under the hero, matching the reference's placement

**Post grid**
- 3-column grid, hairline dividers between cards (both row and column dividers, per the reference)
- Each card, top to bottom:
  1. Date (small, muted) + tag pill (top-right of image or above title — match reference's top-row placement)
  2. Cover image, duotone-filtered, consistent aspect ratio across all cards
  3. Post title, bold condensed type (smaller cut of the hero font)
  4. Excerpt, 2 lines, sans-serif, muted color, truncated
  5. Metadata row: date + reading time only (no byline — single author, drop the "Text: [author]" credit line from the reference)
- Responsive collapse: 3 → 2 → 1 columns at standard breakpoints; dividers adapt accordingly

**Footer**
- Small, centered credit line under the black-canvas frame (site name + short tagline), echoing the reference's `gola.io/FYRRE` treatment

---

## 6. Post Page Layout

- No black-canvas framing (see §3) — standard white page
- Title in the bold condensed display font (post-scale, not hero-scale)
- Metadata row below title: date + reading time (+ tag pills, linking back to `/tag/[tag]`)
- Cover image full-width or contained (evaluate both at implementation time; reference leans full-bleed)
- Serif body copy, ~680px column, per Phase 3 typography plan
- If part of a series: small "Part N of [series]" indicator near the top, sans-serif, muted, linking to the series page

---

## 7. Tag Pages

- Same card grid as homepage, filtered to one tag, same 3-column treatment
- No black-canvas framing (treat like a post-adjacent page, not the homepage)

---

## 8. Components Checklist

- [ ] Category pill (default / active states, accent-filled when active)
- [ ] Post card (date, tag, image, title, excerpt, metadata row)
- [ ] Hero wordmark component (reusable at hero scale + post-title scale)
- [ ] Nav bar (wordmark + minimal links/icons)
- [ ] Footer credit line
- [ ] Duotone/grayscale image filter (CSS filter or build-time processing — decide at implementation)
- [ ] Series indicator ("Part N of X")

---

## 9. Explicit Departures from the Reference

Noting these so nothing gets "corrected" back toward the source image by accident during implementation:

- Body copy is serif, not sans (reference is sans throughout)
- Cover images are required on every post here, vs. optional in a general blog — but treated with a filter, not shown in raw full color
- Byline/author credit is dropped — single-author site
- Black-canvas page-framing is homepage-only, not applied to post/tag/admin pages
- One accent color (orange) added — reference is pure grayscale with no color anywhere
