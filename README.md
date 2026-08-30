# Personal blog — Phases 1–3

A single-user, Medium-style publishing platform. Phase 1 laid the foundation
(schema, migrations, post CRUD). Phase 2 added the writing experience: a
password-gated `/admin` area, a Tiptap editor with autosave, image upload to
R2, and the publish flow. Phase 3 adds the public reading site: a paginated
feed, post pages, tag pages, and RSS — statically generated and dropped from
cache the moment you publish.

- **Framework** — Next.js 16 (App Router), TypeScript
- **Database** — Neon Postgres via Drizzle ORM + `@neondatabase/serverless`
- **Hosting** — Cloudflare Workers via `@opennextjs/cloudflare`
- **Editor** — Tiptap 3
- **Media** — Cloudflare R2, via a Worker binding

---

## Quick start

```bash
npm install
cp .env.example .env.local     # Neon URL, admin password, session secret
npm run db:migrate
npx wrangler r2 bucket create topsailcashew-blog-media          # once
npx wrangler r2 bucket create topsailcashew-blog-media-preview  # once
npm run dev
```

<http://localhost:3000> is the public site; <http://localhost:3000/admin> is
where you write — sign in with `ADMIN_PASSWORD`.

The bucket and KV commands only matter for a deployed Worker. `npm run dev`
and `npm run cf:preview` back every binding with local on-disk storage, so
uploads and the page cache work before any of them exist.

---

## Environment variables

| Variable | Required | Used by | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | app, migrations, tests | Neon connection string. The pooled (`-pooler`) endpoint is fine — the HTTP driver does not hold connections. |
| `ADMIN_PASSWORD` | yes | login | The password for the one author. Checked in constant time against what the login form sends. |
| `SESSION_SECRET` | yes | login, proxy | HMAC key for the session cookie. `openssl rand -base64 32`. Rotating it signs you out. Without it every admin request is refused (see [Auth](#auth)). |
| `R2_PUBLIC_BASE_URL` | no | media | Serve uploads from an r2.dev or custom domain instead of proxying them through the Worker. Applies to *new* uploads. |
| `NEXT_PUBLIC_SITE_URL` | for RSS | public site | Absolute origin, e.g. `https://blog.example.com`. **Inlined at build time**, so it must be set wherever you run `npm run cf:deploy` — not as a Worker variable. Without it, feed links and images are relative and will not resolve in a reader. |
| `NEXT_PUBLIC_SITE_NAME` | no | public site | Header and feed title. Defaults to "Topsail Cashew". |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | no | public site | Tagline under the title and the feed description. |
| `TEST_DATABASE_URL` | tests only | `npm test` | A scratch database. **The suite truncates every table**, so never point this at real data. Falls back to `DATABASE_URL` if unset. |
| `NEON_FETCH_ENDPOINT` | no | app | Redirects the Neon HTTP driver at a local SQL-over-HTTP proxy (e.g. Neon Local) so `next dev` can run against a plain Postgres. Leave unset in production. |

**R2 needs no credentials.** The bucket is reached through the `MEDIA_BUCKET`
binding declared in [`wrangler.jsonc`](wrangler.jsonc), so there is no access
key ID or secret to store anywhere. Only the bucket name is configuration.

Local files, in Next's precedence order: `.env.local`, then `.env`. Both are
gitignored; `.env.example` is the template.

`wrangler dev` does **not** read `.env.local` — a local Worker run reads
`.dev.vars` instead. Copy `.dev.vars.example` to `.dev.vars` for that.

In production these are Worker **secrets**, not plaintext vars:

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

---

## Migrations

Drizzle Kit generates plain SQL from the schema in
[`src/db/schema.ts`](src/db/schema.ts); a small runner applies it.

```bash
npm run db:generate   # schema change -> new drizzle/NNNN_*.sql
npm run db:migrate    # apply anything pending
npm run db:studio     # browse the data
```

Migrations are ordinary SQL files under [`drizzle/`](drizzle) and are meant to
be committed. `db:migrate` is idempotent — applied migrations are tracked in
`drizzle.__drizzle_migrations`, so re-running it is a no-op.

The runner connects over plain TCP (node-postgres) rather than the HTTP driver:
DDL wants a real transaction, and migrations only ever run from a laptop or CI,
never from the Worker.

---

## API

Mutating routes require a session cookie — see [Auth](#auth).

Request and response bodies use `snake_case`, matching the field names in the
project spec.

### `POST /api/posts`

Creates a post. Defaults to `draft`. Only `title` is required.

```bash
curl -X POST localhost:3000/api/posts \
  -H 'content-type: application/json' \
  -d '{"title":"On writing","excerpt":"A short note","tags":["Essays"]}'
```

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | Required. |
| `slug` | string | Optional override; otherwise derived from the title. |
| `content_json` | any | Tiptap document. |
| `content_html` | string \| null | See [rendering](#content_html-is-not-generated-yet). |
| `excerpt` | string \| null | |
| `cover_image_url` | url \| null | |
| `status` | `draft` \| `published` | Defaults to `draft`. |
| `tags` | string[] | Tag *names*; created on demand. |

→ `201 { "post": { … } }`

### `GET /api/posts`

`?status=draft|published` filters; `?limit=` (default 50, max 100) and
`?offset=` paginate. Ordered by `published_at`, falling back to `created_at`,
newest first.

→ `200 { "posts": [ … ], "limit": 50, "offset": 0 }`

### `GET /api/posts/:id`

→ `200 { "post": { … } }` · `404` unknown · `422` id is not a uuid

### `PATCH /api/posts/:id`

Accepts the same fields as create. Only the fields present in the body are
touched; passing `null` clears a nullable field.

→ `200 { "post": { … } }`

### `DELETE /api/posts/:id`

→ `204` (tag links go with it) · `404` unknown

### `POST /api/auth/login`

`{ "password": "…" }` → `200` and a session cookie, or `401`.

### `POST /api/auth/logout`

Clears the cookie. Safe to call when already signed out.

### `POST /api/media`

`multipart/form-data` with a `file` field and an optional `alt_text`.

→ `201 { "media": { id, r2_key, url, alt_text, created_at } }`

### `GET /api/media`

The 50 most recent uploads, newest first.

### `GET /media/<key>`

Streams an object out of R2. Public, cached, `304` on a matching ETag.

### Errors

| Status | Meaning |
| --- | --- |
| `400` | Body was not valid JSON, or not multipart where multipart was expected |
| `401` | No valid session |
| `404` | No such post or object |
| `409` | Slug taken (only after the retry budget is exhausted) |
| `413` | Upload over the 10 MB limit |
| `422` | Validation failed — `details` maps field → messages |
| `500` | Unexpected; logged server-side |

---

## Behaviour worth knowing

### Slugs

Generated from the title, lowercased, accent-folded (`Café` → `cafe`),
punctuation dropped, capped at 80 characters. On collision the first free slug
in the `base`, `base-2`, `base-3`, … series is used. The unique index is the
real guarantee: if a concurrent write takes the slug between the lookup and the
insert, the write retries against the next free one.

**Editing a title does not change the slug.** Permalinks stay put; pass `slug`
explicitly to move a post. A manual slug still goes through the uniqueness
check, so overriding to a taken slug yields `taken-2` rather than an error.

### Publishing

`published_at` is stamped the first time a post is published, and **preserved**
when it is unpublished — re-publishing does not silently move a post to the top
of the feed. Backdating is not exposed by the API yet.

### Cover image URLs

`cover_image_url` accepts an absolute `http(s)` URL **or** a site-relative path
like `/media/2026/08/abc-cover.png`, which is what an upload returns when no
`R2_PUBLIC_BASE_URL` is set. Protocol-relative `//host/...` is rejected — it
would point off-site.

*(Phase 1 only accepted absolute URLs; this was widened in Phase 2 when the
first real upload failed validation.)*

### Tags

`tags` is a set of names, and a patch containing it **replaces** the whole set
(`[]` clears it). Omit the key to leave tags untouched. Tags are identified by
slug, so `Web Design`, `web design` and `web-design` are one tag; the first
spelling to arrive wins the display name.

Tag rows are never garbage-collected, so a tag can outlive its last post. That
is harmless now and worth a cleanup pass when tag pages land in Phase 3.

### `content_json` and `content_html`

`content_json` is the source of truth. `content_html` is the render cached for
fast public reads and RSS; the editor generates it from the live Tiptap
instance on every save, so the two cannot drift.

The API still accepts `content_html` directly — it does not derive it
server-side. Anything writing posts outside the editor (an import script, say)
is responsible for sending both. Nothing reads `content_html` yet; Phase 3's
public pages will.

---

## Deploying to Cloudflare

```bash
npx wrangler login
npx wrangler r2 bucket create topsailcashew-blog-media
npx wrangler r2 bucket create topsailcashew-blog-media-preview

# ISR cache for the public pages. Paste the returned ids into wrangler.jsonc.
npx wrangler kv namespace create NEXT_INC_CACHE_KV
npx wrangler kv namespace create NEXT_TAG_CACHE_KV

npx wrangler secret put DATABASE_URL      # once per environment
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run cf:deploy
```

`npm run cf:preview` builds and runs the real Worker locally on workerd, which
is the only honest way to check a change before shipping — `next dev` runs on
Node and will happily accept things the Workers runtime rejects.

Deploy config lives in [`wrangler.jsonc`](wrangler.jsonc) and
[`open-next.config.ts`](open-next.config.ts). `nodejs_compat` is required.

### Verified

`npm run build`, `npm run cf:build`, a local workerd run, and
`wrangler deploy --dry-run` all pass.

On the built Worker under workerd, against a real Postgres, a real R2 bucket
and a real KV cache: sign-in and sign-out, the auth gate on every protected
route, writing a post with the full mark set, autosave, cover and inline image
upload, tag entry, publish/unpublish, and a reload restoring the draft
byte-for-byte.

For the public site: the feed in the right order, pagination across pages with
no gaps or repeats, a post page rendering `content_html` with its R2 images,
drafts 404ing at their slug, tag filtering, empty tags 404ing, well-formed RSS
with absolute URLs — and publish → appears / retag → moves / unpublish → 404
all confirmed against the live cache.

**Not verified:** a deploy to a live Cloudflare account. The R2 bucket and KV
namespaces exercised were the local on-disk ones `wrangler dev` provides —
same bindings and same APIs as production, but not your account's.

### Worker size

The dry run reports **2876 KiB gzipped** against Cloudflare's 3 MB free-plan
limit — roughly **196 KiB of headroom**, down from 264 KiB before Phase 3.

Phase 3 cost only 68 KiB: the reading pages are server components with no
client JavaScript, and the webfont ships as a static asset, which is uploaded
separately and does not count toward the Worker script.

Check the number before adding anything sizeable — Phase 4's Open Graph image
generation is the obvious risk, since a rendering library would land squarely
in the Worker bundle:

```bash
npx wrangler deploy --dry-run --outdir /tmp/dryrun
```

If it crosses 3 MB the options are the paid plan (10 MB) or moving more
client-only code behind `next/dynamic`, as the editor already is. Most of the
remainder is the Next.js server runtime, which will not shrink.

### Known wrinkle

Next 16 renamed `middleware.ts` to `proxy.ts` and pins it to the Node.js
runtime; route segment config (including `runtime = "edge"`) is rejected in
that file. OpenNext logs `Node.js middleware support is experimental in
cloudflare` on every build as a result. It builds and runs correctly on
workerd — but if a future OpenNext release regresses it, the fallback is to
move the check in [`src/proxy.ts`](src/proxy.ts) into `handle()` in
[`src/lib/http.ts`](src/lib/http.ts), which every route already wraps.

---

## Testing

```bash
createdb blog_test
TEST_DATABASE_URL=postgresql://localhost/blog_test npm test
```

79 tests run the real route handlers against a real Postgres — the suite
migrates the database, then truncates between tests. There are no mocks of the
code under test: `setDbForTesting` in [`src/db/client.ts`](src/db/client.ts)
swaps the Neon handle for a node-postgres one, and the R2 binding is a small
in-memory stand-in passed in as an argument.

Coverage includes session signing and tampering, the protected-route matrix,
magic-byte sniffing, upload size and format limits, and — for the public site
— that drafts stay out of the feed, the slug lookup, the pre-render lists and
the tag pages; that pagination neither drops nor repeats a post; that the feed
sorts by `published_at`; and that RSS escapes correctly and absolutises its
URLs.

[`tests/neon-http.test.ts`](tests/neon-http.test.ts) additionally runs the same
repository code through the **actual Neon HTTP driver** the Worker deploys
with, using a small protocol shim in front of local Postgres. That covers the
places the two drivers genuinely differ — array parameter encoding, the
`db.execute` result shape, and how SQLSTATE codes are nested inside errors.

```bash
npm run typecheck
npm run lint
./scripts/smoke.sh                       # against npm run dev
./scripts/smoke.sh https://your.workers.dev
```

[`scripts/smoke.sh`](scripts/smoke.sh) drives all five endpoints with curl and
deletes what it creates. It needs `jq`.

---

## Schema

Four tables — see [`drizzle/0000_init.sql`](drizzle/0000_init.sql).

```
posts       id, title, slug, content_json, content_html, excerpt,
            cover_image_url, status, published_at, created_at, updated_at
tags        id, name, slug
post_tags   post_id, tag_id                        (composite pk)
media       id, r2_key, url, alt_text, created_at
```

### Choices made on top of the spec

The columns match the spec exactly. These additions do not change any field's
name or type, but they are decisions rather than transcription:

- **`NOT NULL` on `status`, `created_at`, `updated_at`, `media.created_at`.**
  The spec gives each a default but does not say not-null. A nullable column
  with a default invites rows that bypass it, and every read would need a null
  branch. Say the word and they can be relaxed.
- **`CHECK (status in ('draft','published'))`.** The spec expresses this as a
  comment. The API validates it too; this keeps a bad write out of the table
  whatever the client is. It is a plain `text` column, not a pg enum, so adding
  a state later is a data change rather than a type migration.
- **`ON DELETE CASCADE` on both `post_tags` foreign keys**, so deleting a post
  does not strand rows.
- **Three indexes** — `(status, published_at desc)` for the feed query,
  `(created_at desc)`, and `post_tags(tag_id)` for the Phase 3 tag pages.

`tags.name` is not unique (only `slug` is), per the spec. `media` is
intentionally not joined to `posts`: inline images live inside `content_json`,
and `cover_image_url` is a plain URL.

As specified, there is **no `series` table and no `posts.series_id`**.

---

## Auth

One author, one password, one checkpoint.

`ADMIN_PASSWORD` is compared in constant time; on success the server sets an
**HTTP-only, SameSite=Lax** cookie holding an HMAC-SHA256-signed token
(`{ sub, exp }`, 7-day expiry). Nothing is stored server-side, so there is no
session table to keep and signing out is just clearing the cookie.

[`src/proxy.ts`](src/proxy.ts) is the only place auth is enforced. It calls
`isProtected(pathname, method)` and `authorize(request)` from
[`src/lib/auth.ts`](src/lib/auth.ts); no route handler contains an auth check.
To protect something new, add it to `isProtected` — not to the handler.

| Route | Gated |
| --- | --- |
| `/admin/*` | every method |
| `/api/posts`, `/api/posts/:id` | `POST` / `PATCH` / `DELETE` only |
| `/api/media` | every method |
| `GET /api/posts`, `GET /api/posts/:id` | open — Phase 3's public pages read through them |
| `/media/*` | open — images must load in a browser without a cookie |
| `/admin/login`, `/api/auth/*` | open |

Page routes redirect to `/admin/login?next=…`; API routes get a JSON `401`. The
`next` parameter is validated, so a crafted link cannot bounce you off-site
after signing in.

**It fails closed.** With `SESSION_SECRET` unset, every cookie would verify
against an empty key, so `authorize()` refuses everything with a `500` and logs
why rather than silently granting access.

### What this is not

No rate limiting beyond a fixed ~400 ms delay on a wrong password. Workers have
no shared memory between isolates, so a counter would not actually count.
If this ever faces real traffic, put Cloudflare WAF rate limiting in front of
`/api/auth/login` — it belongs at the edge, not in the handler.

Sessions cannot be revoked individually; rotating `SESSION_SECRET` invalidates
all of them at once. For one user that is the same thing.

Signing out clears the browser's cookie — it does not revoke the token, which
stays valid until it expires. Nothing is stored server-side to revoke against.
If a session token were ever captured, rotating `SESSION_SECRET` is the way to
kill it.

---

## The public site

Four routes, all statically generated, none shipping any client JavaScript of
their own.

| Route | What it is |
| --- | --- |
| `/` | Newest ten published posts |
| `/page/2`, `/page/3`, … | Older pages. `/page/1` redirects to `/` so there is one canonical URL for the first page |
| `/[slug]` | The post |
| `/tag/[tag]` | Posts carrying that tag |
| `/rss.xml` | RSS 2.0 |

**Only published posts are reachable.** Every public read goes through
[`src/lib/public-posts.ts`](src/lib/public-posts.ts), which pins
`status = 'published'` into each query — so a draft is indistinguishable from
a slug that never existed, and both produce a real 404. A tag carried only by
drafts 404s too, rather than rendering an empty page for a crawler to index.

### Pagination, not infinite scroll

Ten posts a page. Each page is a real URL, so it is cacheable, linkable, and
crawlable, and it works with JavaScript off. Infinite scroll would trade all
of that for client state and a fetch waterfall over content that is otherwise
completely static.

### Revalidation is on demand

Pages are rendered once and served from KV. When a post is created, edited,
published, unpublished, or deleted, the write path calls
[`revalidatePublicPages`](src/lib/revalidate.ts) and the affected pages are
dropped; the next visitor gets a fresh render.

Time-based revalidation was the alternative. It was the wrong trade here: this
blog changes a few times a month, so a short window would re-query Neon
forever for pages nobody touched, and a long one would leave a typo fix
sitting stale. The hourly `revalidate` that *is* set is only a backstop in
case an invalidation is ever missed.

Two details that are easy to get wrong:

- **Draft autosave must not invalidate anything.** The editor saves every ten
  seconds; `affectsPublicOutput()` keeps that churn away from the public cache
  by checking whether the post is — or just stopped being — published.
- **Invalidation uses concrete paths, never route patterns.**
  `revalidatePath("/[slug]", "page")` looks right and does nothing against the
  KV tag cache: entries are keyed by real pathname, so the pattern matches
  none of them. Caught by an unpublished post that kept serving a 200. The
  write path now passes both the old and new slug and the old and new tags, so
  a rename or a retag leaves nothing behind at the previous URL.

Cache invalidation is best-effort: the write has already committed, so a
failure there is logged rather than turned into a 500 on a save that
succeeded.

### Typography

The reading column is the point of this phase.

- **Body** — Source Serif 4, loaded through `next/font`, which self-hosts it
  from our own origin at build time. No request to Google, and only the two
  subsets actually used (roman and italic) ship.
- **Chrome** — the system sans stack for nav, dates, tags and pagination, so
  UI paints instantly and reads as distinct from the prose.
- **Measure** — 42rem, giving **66 characters a line** at 19px, inside the
  60–75 that is comfortable to read. 36 characters on a 375px phone, which is
  what the width allows at a legible size.
- **Rhythm** — 1.75 line-height, 1.9rem between blocks. That spacing is in
  `rem` on purpose: in `em` it resolves against the *child*, so the gap above
  a code block would quietly shrink and break the rhythm.
- **Dark mode** — included, because with custom properties it was a dozen
  lines. Both palettes are warm rather than pure grey.
- **Contrast** — every text token meets WCAG AA against its background. The
  muted date line originally sat at 3.4:1; it is now 4.7:1.

Images use plain `<img>`, not `next/image`. Covers are already in R2 at the
size the author uploaded, and the optimizer would add a Worker dependency for
no gain. Feed thumbnails get a fixed 2:1 box so rows do not jump as they load.

### RSS

RSS 2.0 at `/rss.xml`, with `content:encoded` carrying the full post HTML.
Site-relative image and link URLs are rewritten to absolute — a feed reader
resolves relative URLs against its own origin, so `/media/…` would otherwise
point at the wrong host. That rewrite needs `NEXT_PUBLIC_SITE_URL`; the route
logs a warning when it is unset.

---

## The editor

`/admin/posts/[id]`, with `new` as a special id. Tiptap 3 with a fixed
**toolbar** rather than a slash menu — every available mark is visible without
having to know it exists, and keyboard shortcuts still work alongside it.

Supported: bold, italic, inline code, H1–H3, bullet and numbered lists,
blockquote, code block, links, and images.

The document schema is defined once, in
[`src/components/editor/extensions.ts`](src/components/editor/extensions.ts).
Both `content_json` and `content_html` come from the same live editor instance
on save, so the stored HTML can never drift from the stored JSON.

### Autosave

Saves 10 seconds after a change, and immediately on blur, tab-hide, and
navigating away. The indicator shows *Unsaved changes* → *Saving…* → *Saved
just now*, and a failure stays on screen with the reason until the next
successful save.

Comparison is on the serialized draft, not object identity, so a re-render that
produces an equal document is not a change. A save that lands while another is
in flight is queued and re-run once, rather than racing.

`/admin/posts/new` does not create a row until there is a title or some body
text — opening the page and closing it again leaves nothing behind. On that
first save the URL is swapped to the real post id with
`history.replaceState`, deliberately not `router.replace`: the latter remounts
the editor and would reset the indicator to "no changes" the instant the first
save succeeded.

### Images

Drop, paste, or pick a file. Each upload goes to `POST /api/media`, which:

1. rejects anything over **10 MB** (checked from `Content-Length` before the
   body is parsed, so the failure is a clear `413`),
2. identifies the format from the file's **magic bytes**, not the browser's
   `Content-Type` header,
3. stores it in R2 under `YYYY/MM/<random>-<slug>.<ext>`,
4. records `r2_key`, `url` and `alt_text` in the `media` table,
5. returns the URL, which the editor inserts as an image node.

Accepted: JPEG, PNG, GIF, WebP, AVIF. **SVG is deliberately refused** — uploads
are served from this app's own origin, and an SVG can carry script, which would
make the upload form a stored-XSS hole.

The cover image uses the same endpoint and writes `posts.cover_image_url`.

Uploads are served back through `GET /media/<key>` with a long immutable
cache header, an ETag (so a revisit costs a `304`), and `nosniff`. That keeps
the bucket private and needs no extra setup. Set `R2_PUBLIC_BASE_URL` to serve
new uploads from a CDN domain instead; existing objects keep resolving through
the Worker.

Nothing deletes from R2 yet. Removing an image from a post leaves the object
and its `media` row in place — worth a sweep when the media library grows.

---

## Layout

```
src/
  app/
    (public)/layout.tsx             site chrome for every reading page
    (public)/page.tsx               home feed
    (public)/page/[page]/           older feed pages
    (public)/[slug]/page.tsx        the post
    (public)/tag/[tag]/page.tsx     posts by tag
    (public)/not-found.tsx          real 404 for drafts and unknown slugs
    rss.xml/route.ts                RSS 2.0
    admin/login/page.tsx            sign-in (outside the dashboard chrome)
    admin/(dashboard)/page.tsx      post list, filterable by status
    admin/(dashboard)/posts/[id]/   the editor; `new` is a special id
    api/posts/…                     post CRUD (Phase 1)
    api/auth/login|logout/          session in, session out
    api/media/route.ts              upload + recent uploads
    media/[...key]/route.ts         serves objects back out of R2
  components/
    public/PostList.tsx             feed layout, shared by home and tag pages
    public/PostMeta.tsx             date, reading time, tags
    public/Pagination.tsx           numbered pages
    editor/extensions.ts            the document schema, defined once
    editor/EditorToolbar.tsx        formatting controls
    admin/PostEditorLoader.tsx      client-only dynamic import of the editor
    admin/PostEditor.tsx            editor shell, autosave, publish, delete
    admin/TagInput.tsx, CoverImagePicker.tsx, SaveStatus.tsx, LoginForm.tsx
  db/
    schema.ts                       Drizzle schema — source of truth
    client.ts                       Neon HTTP handle + the test seam
    node.ts                         node-postgres handle (migrations/tests)
  lib/
    public-posts.ts                 every public read — published-only, in one place
    revalidate.ts                   which cached pages a write drops
    site.ts                         site name, origin, date formatting
    posts.ts                        post repository — all post SQL
    tags.ts                         tag upsert + association sync
    slug.ts                         slugify, uniqueness, SQLSTATE detection
    media.ts                        validation, R2 write, media row
    r2.ts                           bucket binding + public URL resolution
    session.ts                      HMAC sign/verify, constant-time compare
    auth.ts                         what is protected, and who is allowed
    redirect.ts                     `?next=` guard (shared with the client)
    use-autosave.ts                 the autosave hook
    upload-limits.ts                the size cap, shared with next.config.ts
    upload-client.ts                browser-side upload helper
    validation.ts                   zod schemas; the snake_case wire contract
    http.ts                         one place where errors become responses
  proxy.ts                          the single auth checkpoint
drizzle/                            generated SQL migrations
scripts/                            migrate.ts, smoke.sh
tests/                              integration tests + Neon HTTP shim
```

---

## Phase status

**Done — Phase 1.** Schema and migrations · Cloudflare-deployable scaffold ·
post CRUD · slug generation · implicit tag upsert · auth seam.

**Done — Phase 2.** Password login and signed session cookies · gated admin
area and mutating API · Tiptap editor with a full toolbar · autosave with a
visible status · image upload to R2 (inline and cover) · tag input ·
publish/unpublish · filterable admin post list.

**Done — Phase 3.** Paginated public feed · post pages rendering
`content_html` · tag pages · real 404s for drafts and empty tags · typography
pass with a self-hosted serif, dark mode and AA contrast · RSS 2.0 · ISR with
on-demand revalidation.

**Not yet:** full-text search · series grouping · Open Graph image generation
(Phase 4).

---

## Decisions

### Drizzle + `@neondatabase/serverless` over Prisma

Prisma needs a query engine alongside your code. On Workers that means the WASM
engine or Prisma Accelerate — more bundle, more moving parts, and a second
service in the request path. Drizzle is a compile-time query builder: it emits
SQL strings and hands them to a driver, with no native binary and nothing to
initialise at runtime. `drizzle-kit` also generates readable SQL migration files
rather than a proprietary format, so the migrations stay portable if the ORM
ever changes.

### Neon's HTTP driver over WebSockets

`@neondatabase/serverless` offers both. The HTTP driver is one `fetch` per
query — no socket, no pool to keep warm, nothing to clean up in
`ctx.waitUntil`, which suits a Worker that may serve a single request and die.

The cost is that HTTP has no interactive transactions. Rather than reach for
the WebSocket pool, the one write that needs atomicity — swapping a post's tag
associations — is written as a **single statement** (a `DELETE` CTE feeding an
`INSERT`), which Postgres executes atomically. It is also differential, so
untouched rows are left alone instead of deleted and rewritten.

One consequence worth naming: creating a post with tags is two statements (the
post, then its tags), so a failure between them can leave a post with no tags.
The post — the valuable part — is safe, and saving again fixes it. If that ever
matters, `drizzle-orm/neon-serverless` gives real transactions with a
WebSocket pool.

### `npm audit` reports 4 moderate advisories

All four are one issue: the esbuild version bundled inside `drizzle-kit`. The
advisory is about esbuild's **dev server** accepting cross-origin requests.
`drizzle-kit` is a devDependency that never runs that server, and none of this
reaches the Worker bundle. Fixing it means waiting for `drizzle-kit` to bump —
`npm audit fix --force` downgrades it and breaks migrations.
