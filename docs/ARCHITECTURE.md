# Architecture

How **topsailcashew** is built, and the reasoning behind the parts that are
not obvious. The [README](../README.md) describes the blog itself; this is the
engineering record.

A single-user, Medium-style publishing platform.

- **Phase 1** — Neon schema, migrations, post CRUD.
- **Phase 2** — password-gated `/admin`, Tiptap editor with autosave, R2 image
  upload, publish flow.
- **Phase 3** — the public reading site: paginated feed, post pages, tag pages
  and RSS, statically generated and dropped from cache the moment you publish.
- **Phase 4** — series grouping, Postgres full-text search, Open Graph cards,
  and reader comments with a moderation queue.

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
npm run db:seed-pages          # About / Newsletter / Contact, once
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
| `NEXT_PUBLIC_CF_ANALYTICS_TOKEN` | no | public site | Cloudflare Web Analytics site token. When set, the beacon script is added to every page; when unset, no analytics code is emitted at all. Inlined at build time like the other `NEXT_PUBLIC_*` values. |
| `COMMENT_RATE_LIMIT` | no | comments | Submissions allowed from one address per hour. Defaults to **5**. |
| `ADMIN_EMAIL` | no | comments | Recorded against replies you write from the moderation queue. Cosmetic; never shown publicly. |
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

**Admin only**, like every other route under `/api/posts` — see
[Auth](#auth) for why this stopped being public.

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

Moves the post to the trash. The row survives, with its tags, comments and
revisions; nothing public can reach it. Add `?permanent=1` to delete the row
for good (tag links, comments and revisions then go with it via cascade).

→ `204` · `404` unknown

### `POST /api/posts/:id/restore`

Brings a post back out of the trash.

→ `200 { "post": { … } }` · `404` unknown, or not in the trash

### `DELETE /api/posts/trash`

Empties the trash. A fixed path, so it can never collide with
`/api/posts/:id` — `trash` is not a uuid, and the id route validates that
before touching the database.

→ `200 { "deleted": <count> }`

### `GET /api/posts/:id/revisions`

→ `200 { "revisions": [ { id, title, excerpt, reason, created_at } ] }`,
newest first. Bodies are not included; the list is for choosing one.

### `POST /api/posts/:id/revisions`

`{ "revision_id": "<uuid>" }` restores that snapshot over the live post,
snapshotting the current text first. A revision belonging to a different post
is a `404`, not a cross-post write.

→ `200 { "post": { … } }` · `404` unknown post or revision

### `POST /api/posts/:id/preview`

→ `200 { "url": "https://…/preview/<token>", "expires_in": 604800 }`

### `GET|POST /api/pages`, `GET|PATCH|DELETE /api/pages/:id`

Same shapes as the post routes, minus tags, series, cover and dates. All admin
only.

### `POST /api/auth/login`

`{ "password": "…" }` → `200` and a session cookie, or `401`.

### `POST /api/auth/logout`

Clears the cookie. Safe to call when already signed out.

### `POST /api/media`

`multipart/form-data` with a `file` field and an optional `alt_text`.

→ `201 { "media": { id, r2_key, url, alt_text, filename, content_type,
size_bytes, created_at } }`

### `GET /api/media`

→ `200 { "media": [ … ], "total": <count> }`, newest first.
`?q=` searches filename and alt text, `?limit=` (max 200) and `?offset=` page.

### `GET /api/media/:id`

→ `200 { "media": { … }, "usage": [ { kind, id, title } ] }`

`usage` is every post or page referencing the URL — as a cover, as an Open
Graph image, or inside the rendered body HTML.

### `PATCH /api/media/:id`

`{ "alt_text": "…" | null }`. Alt text is the only editable field.

### `DELETE /api/media/:id`

Removes the row and the R2 object. Refuses with `409` and the usage list while
anything still references the image; `?force=1` overrides.

→ `204` · `409 { "error": …, "usage": [ … ] }` · `404` unknown

### `GET /api/import`

→ `200 { imported_posts }` — how many posts came in this way.

### `POST /api/import`

`{ "documents": [ { "path": "essays/x.md", "content": "…" } ] }`, at most ten
per request. Files each as a draft and reports on each one individually, so a
document that fails does not sink the batch.

→ `200 { items: [ { path, outcome, postId?, title?, detail? } ] }` ·
`422` for an empty or over-large batch

### `GET|POST /api/redirects`, `DELETE /api/redirects/:id`

`POST` takes `{ "from_path": "/old", "to_path": "/new" }`; `to_path` may be an
absolute URL. A source that already exists is replaced, not duplicated.

→ `201 { "redirect": { … } }` · `422` if it would point at itself

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

Posts and pages share one namespace. They both render through `/[slug]`, which
resolves a post first — so a post allowed to take a page's slug would not
collide in the database, it would just make the page unreachable. Allocation
checks both tables, and a handful of router-owned names (`admin`, `api`,
`articles`, `search`, `tag`, …) are reserved outright.

### Redirects

Changing a slug records a permanent redirect from the old path, so inbound
links, shares and search results keep working. Without it a rename 404s
silently and nothing errors — which is why this is not optional.

Three invariants are enforced when one is recorded, all in `recordSlugChange`:

- **No self-redirect.** Renaming back to a previous slug would otherwise leave
  `/a → /a`, a loop.
- **Chains are collapsed.** Rename `a → b → c` and the row for `/a` is
  retargeted to `/c`, never left pointing at `/b`. One hop, always.
- **A destination cannot also be a source.** If something moves *into* a path
  that was being redirected away, that row is dropped — the post lives there
  now.

Lookups normalise case, trailing slashes and query strings, so
`/Old-Post/?utm_source=x` and `/old-post` are the same key. The check happens
only after both a post and a page have missed, so it costs a query on a
genuine 404 and nothing on a page that exists. Rules are editable at
`/admin/redirects`, and a hand-written one may point off-site.

### Trash

`DELETE` moves a post to the trash rather than removing it. `deleted_at` is
set, and every public query filters it out through the same `publishedOnly`
predicate that handles drafts and scheduling — one place, so a new query
cannot forget it. The admin list hides trashed posts unless asked for them.

A trashed post keeps its slug reserved. Letting a new post claim the URL would
mean restoring silently returns the post at `slug-2`, which is a worse
surprise than a name being briefly unavailable.

Emptying the trash is the only genuinely irreversible action in the admin.

### The featured post

The home page leads with the newest post marked `featured`, or — when nothing
is marked — simply the newest post. That fallback is the point: the page
should never have a hole in it because a box has not been ticked, and on a
blog where nothing is ever featured, the newest post is the right thing to
lead with anyway.

Nothing constrains the column to a single row. A uniqueness rule would make
featuring a post two writes that can half-fail; instead the newest featured
post wins, so setting a new one is one write and the previous one simply stops
being the most recent.

The lead post is filtered out of the grid beneath it — the same post twice on
one screen reads as a duplicate rather than as emphasis — and the whole filter
row is skipped when it was the only post there was.

### Per-post SEO

Five nullable columns, each an override with a derived fallback, so a post
with none set renders exactly as it did before they existed:

| Field | Falls back to |
|---|---|
| `meta_title` | the post title |
| `meta_description` | the excerpt, then the site description |
| `canonical_url` | the post's own URL |
| `og_image_url` | the cover, then the generated card, then the site card |
| `noindex` | `false` |

`noindex` keeps a post live and linkable but out of search results, and drops
it from the sitemap — listing a URL while telling crawlers to ignore it is
reported as an error rather than quietly obeyed. `canonical_url` is applied to
both the `<link rel="canonical">` and the JSON-LD `mainEntityOfPage`, so a
crawler is never told two different things.

### The editor

Two columns: the writing surface on the left, a sticky settings sidebar on the
right holding four collapsible sections — **Publish**, **Details**, **SEO** and
**History**. Each is a `<details>` element, so the disclosure semantics and
keyboard handling come from the browser and every section behaves the same
way. History fetches its list the first time it is opened, not on page load.

**Preview** opens the post as a reader sees it. A published post has a public
URL already; a draft or a scheduled post has none, so the button mints a signed
preview token and opens that instead. Pending edits are flushed first, so what
opens is what was just typed.

"Scheduled" is shown wherever a status is — the editor bar, the dashboard, the
article list — even though no such value is stored. It is `published` with a
future date, and `postStatusLabel` is the single place that decides.

### Importing documents

`/admin/import` takes files or a whole folder, dragged in or picked, and files
each document as a **draft**. An import is a transfer of raw material, never a
publishing decision.

This replaced a Google Drive integration. That version worked, but it asked
for a Google Cloud project, a service account, a JSON key and a folder share
before it could import a single file — a great deal of setup standing between
a writer and their own words. Dragging a folder in needs none of it.

**Files are read in the browser** and their text posted as JSON rather than
uploaded as multipart. A folder of essays is a few hundred kilobytes of text,
and this way there is no file-size ceiling to explain, no temporary storage,
and "which of these am I actually importing?" is answered on screen before
anything is sent. Documents go in batches of ten, because Next buffers a whole
request body for the proxy and one enormous body would be rejected with a
message that explains nothing; the progress counter is the visible benefit.

**Folder traversal** uses `webkitGetAsEntry`, falling back to a flat file list
where that is unavailable. `readEntries` returns at most 100 children per call
and signals the end with an empty batch, so it is called in a loop — the
obvious one-shot implementation silently truncates any folder with more than a
hundred items in it.

**What can be read.** `.md`, `.markdown` and `.txt` directly; `.docx` by
extracting it; `.zip` by opening it and treating the contents as though they
had been dropped. Anything else is counted and named as ignored rather than
failing the drop.

A `.docx` is a zip of XML, so both need an unzipper. There is no dependency for
it: `DecompressionStream("deflate-raw")` is the inflater every current browser
has, and the container format is a few structs — see `zip-reader.ts`. The
central directory is read rather than the local headers scanned, because a
local header may declare sizes of zero and defer them to a trailing
descriptor, which a forward scan reads as an empty file.

**`.docx` becomes Markdown**, not Tiptap JSON. The server already has a tested,
hardened Markdown reader that clamps headings, filters link schemes and refuses
anything the editor cannot represent; emitting Markdown means every imported
document goes through that same door instead of the extractor becoming a
second, unvalidated way to write `content_json`. Word's text is escaped on the
way out and unescaped on the way back in, so an asterisk someone typed does not
return as emphasis.

Read from the document: headings (Word's `Title` and `HeadingN` styles,
clamped to three levels), bold, italic, strikethrough, hyperlinks resolved
through the relationships part, and lists — bulleted or numbered, with
indentation, which needs `numbering.xml` as well since a `numId` only points
at the definition carrying the format. Tables and images are named in the
preview rather than dropped silently: the editor has no table node, and an
image needs uploading rather than embedding.

**A `.gdoc` is not a document.** Google Drive for Desktop writes a couple of
hundred bytes of JSON holding the file's id; the text never leaves Google's
servers. Nothing can be extracted locally, so it is reported with what to do
instead — File → Download → Microsoft Word — and a link to open it.

**Re-import rules.** A document is identified by its path within the drop
(`essays/2026/slow-software.md`), stored in `posts.import_key`, so dropping the
same folder again updates the drafts it made last time instead of producing a
second copy of everything:

| State | What happens |
|---|---|
| Not seen before | A new draft |
| Published | Never touched — the file on disk stops being the source of truth once a piece is live |
| Still a draft | Content replaced from the file |

The slug is generated once, on first import, and never revised: a slug that
moved because a heading changed would break the post's URL. The import key is
written in the same `INSERT` that creates the post rather than a follow-up
`UPDATE`, so a concurrent import cannot slip through the gap and create a
duplicate.

**Markdown to Tiptap.** The target is not Markdown in general, it is exactly
the node set `src/components/editor/extensions.ts` defines. `content_json`
that does not round-trip through the editor is corruption that only surfaces
the next time the post is opened, so: headings clamp to H1–H3 rather than
being dropped, images are lifted to block level because the Image extension is
`inline: false`, and link destinations are filtered to the same schemes the
editor allows — an import must not be a way to smuggle in a `javascript:` URL.
Destinations are scanned rather than pattern-matched, because a URL may contain
balanced parentheses and a regex that stops at the first `)` swallows half of a
Wikipedia link and leaks the rest into the sentence.

### Media library

`/admin/media` browses, searches, retags and deletes uploads.

"Where is this used?" is answered by searching for the URL rather than by a
join table. An image can be a cover, an Open Graph image, or an inline `<img>`
in rendered HTML — a join table would have to be kept in step with the editor
on every keystroke, and would go stale the moment a URL was pasted by hand. A
`LIKE` cannot go stale, and at this scale it costs nothing. That is what makes
deletion safe to offer: the admin says "used in 2 posts" instead of silently
breaking them, and refuses with `409` unless forced.

Deletion removes the database row before the R2 object. A row pointing at a
missing object is a broken image; an orphaned object is only wasted bytes — so
if the R2 call fails, the half-done state is the one we can live with. Upload
makes the same trade in reverse.

### Publishing and scheduling

`published_at` is stamped the first time a post is published, and **preserved**
when it is unpublished — re-publishing does not silently move a post to the top
of the feed.

The date is also settable directly, through `published_at` on create and
`PATCH`, or the date field in the editor sidebar. Backdating works; so does
dating forward, which is how scheduling works here:

- Every public read filters on `status = 'published' AND published_at <= now()`
  (one predicate, in `src/lib/public-posts.ts`). A post dated forward exists,
  is editable, and shows as **scheduled** in the admin, but the feed, its own
  URL, RSS, search, the sitemap and `generateStaticParams` all treat it as
  absent.
- **There is no cron job.** OpenNext's generated Worker exports only `fetch`,
  and it is regenerated on every build, so a `scheduled` handler would mean
  wrapping its entry point — fragile for what a `where` clause already does.
- The cost of having no cron is latency, not correctness. Nothing fires at the
  scheduled moment, so the post appears when a cached page next refreshes.
  Every list page, the feed, the sitemap **and post pages themselves** use
  `revalidate = 300`, which bounds that to five minutes.
- Post pages share the short window for a specific reason: until its time
  arrives, a scheduled post's URL returns a 404, and that 404 caches like any
  other response. Whoever visits early — the author, checking their own link —
  would otherwise pin it there for the length of the window. Opting that one
  render out of the cache is not possible: calling a dynamic API from a route
  that declares `revalidate` is an error, not a fallback.

A post published with **no** date set is not visible either — `null <= now()`
is `NULL`, not true. The editor shows the empty field, so this is visible
rather than mysterious.

### Revisions

Snapshots live in `post_revisions` and hold `title`, `excerpt` and
`content_json` only. `content_html` is not stored: it is derived from the JSON
(`src/lib/tiptap-html.ts`), and keeping both would roughly double the size of
every row for no new information.

The rules that keep the table small — all in `src/lib/revisions.ts`:

- **Not every autosave.** The editor saves every ten seconds; snapshotting each
  one is what makes WordPress revision tables enormous. An ordinary edit
  snapshots at most **once an hour**.
- **Always on a publish or unpublish**, regardless of that throttle — those are
  the moments worth returning to.
- **Never a duplicate.** If the text is identical to the newest snapshot,
  nothing is written, whatever the reason. The list tracks versions of the
  text, not a change log.
- **Capped at `MAX_REVISIONS_PER_POST` (20)**, pruned on write. Pruning deletes
  by id rather than "older than the oldest kept timestamp", because `now()` is
  fixed for a whole transaction and two snapshots can share a `created_at`.

Restoring snapshots the current text first, so a restore is itself undoable.

### Draft preview links

`POST /api/posts/:id/preview` (admin only) mints a signed, expiring URL at
`/preview/<token>` that renders a draft to anyone holding it. The token carries
one post id and an expiry, signed with `SESSION_SECRET` — so rotating that
secret invalidates every outstanding link.

Two details worth keeping:

- The signed message is **domain-separated** from the session cookie
  (`preview:` prefix), so neither token can ever be replayed as the other even
  though both use the same key.
- It is a **separate route**, not `/[slug]?preview=…`. Reading a search
  parameter on the post page would make it dynamic for every visitor and cost
  the whole site its static rendering; here the dynamic rendering is confined
  to a route nobody reaches without a token.

The preview page sets `noindex, nofollow, nocache`, and `/preview/` is
disallowed in `robots.txt`.

### Pages

About, Newsletter and Contact are rows in `pages`, not hardcoded routes, so the
copy is editable at `/admin/pages` without a deploy. `npm run db:seed-pages`
creates the three the nav links to, with placeholder text; it never touches a
page that already exists, so it is safe to re-run.

They render through `/[slug]`, which resolves a **post first** and falls back to
a page. To stop a post from silently shadowing a page, `findAvailableSlug`
treats the two tables as one namespace, and `RESERVED_SLUGS` keeps both off the
names the router owns (`/search`, `/tag`, `/admin`, …).

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

### Migrations run before the deploy, not after

`npm run cf:deploy` builds against `DATABASE_URL`, and the build reads posts —
`generateStaticParams`, the RSS route, and the Open Graph script all query the
database. If the schema is behind the code, the build fails with a Postgres
`42703` (undefined column) rather than deploying something broken, which is the
right failure but an opaque one if you are not expecting it.

So the order is always:

```bash
npm run db:migrate     # bring Neon up to date first
npm run cf:deploy
```

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

The dry run reports **2910 KiB gzipped** against Cloudflare's 3 MB free-plan
limit — about **162 KiB of headroom**. The webfonts ship as static assets,
which are uploaded separately and do not count toward the Worker script.

Phase 4 nearly broke this. Generating Open Graph images inside the Worker
measured 3289 KiB, 217 KiB *over* the limit, so that work moved to a build step
(see [Open Graph images](#open-graph-images)). The comment form is also loaded
with `next/dynamic` so it stays out of the server bundle — the same trick the
editor uses — which recovered a further 111 KiB.

Check the number before adding anything sizeable:

```bash
npx wrangler deploy --dry-run --outdir /tmp/dryrun
```

If it crosses 3 MB the options are the paid plan (10 MiB) or moving more
client-only code behind `next/dynamic`. Most of the remainder is the Next.js
server runtime, which will not shrink.

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

139 tests run the real route handlers against a real Postgres — the suite
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

Phase 4 adds coverage for the parts most worth getting wrong: that a comment
lands as pending and cannot be seen until approved, that rejected and spam
comments stay out of the public thread but remain in the queue, that an email
address is absent from the public shape entirely, that a filled honeypot writes
nothing while answering like a real submission, that the rate limit stops one
address without touching another, that only a hash of the address is stored,
that a reply aimed at a reply is flattened to one level, that series parts are
numbered by publication date and unaffected by a draft in the middle, that
deleting a series frees its posts rather than removing them, and that search
ranks a title match above a body match and never returns a draft.

Later work adds: that a post dated forward is hidden from the feed, its own
URL, RSS, search and the pre-render list, and appears once its time passes with
no further write; that an autosave storm produces one revision rather than one
per save, that a publish always snapshots but an identical snapshot never
does, that pruning holds the cap, and that restoring a revision belonging to a
different post is a 404; that a preview token round-trips, and that a tampered,
expired or foreign-signed one grants nothing — including that a session cookie
and a preview token cannot be replayed as each other; that a page and a post
cannot take each other's slug; and that every read under `/api/posts` is now
gated.

[`tests/neon-http.test.ts`](tests/neon-http.test.ts) additionally runs the same
repository code through the **actual Neon HTTP driver** the Worker deploys
with, using a small protocol shim in front of local Postgres. That covers the
places the two drivers genuinely differ — array parameter encoding, the
`db.execute` result shape, and how SQLSTATE codes are nested inside errors.

To drive the **built Worker** against a local Postgres — which is how the
scheduling, preview and SEO routes were checked — run the same shim as a
standalone server and point the Neon driver at it:

```bash
SHIM_TARGET=postgres://localhost/blog_dev npx tsx scripts/dev-shim.ts
```

Then set `NEON_FETCH_ENDPOINT=http://127.0.0.1:55444/sql` in `.env.local`,
build, and run `npx wrangler dev`. Use a **separate** database from
`TEST_DATABASE_URL`: `npm test` truncates every table, and will wipe your
sample content out from under a running server.

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

Nine tables — see [`drizzle/`](drizzle/) for the migrations.

```
posts           id, title, slug, content_json, content_html, excerpt,
                cover_image_url, status, published_at, created_at, updated_at,
                series_id, search_vector,
                meta_title, meta_description, canonical_url, noindex,
                og_image_url, deleted_at,
                featured, import_key, imported_at
tags            id, name, slug
post_tags       post_id, tag_id                    (composite pk)
media           id, r2_key, url, alt_text, filename, content_type,
                size_bytes, created_at
series          id, title, slug, description, created_at
comments        id, post_id, parent_id, author_name, author_email, body,
                status, created_at, is_author, author_ip_hash
post_revisions  id, post_id, title, excerpt, content_json, reason, created_at
pages           id, title, slug, content_json, content_html, status,
                created_at, updated_at
redirects       id, from_path, to_path, automatic, created_at
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

### Two columns on `comments` that the spec did not list

Both exist to serve features the spec *did* ask for, and both are flagged here
rather than slipped in:

- **`is_author boolean not null default false`** — the spec asks for replies
  written from the admin queue to be "visually marked as the author". Nothing
  else in the row distinguishes them, so there has to be a flag.
- **`author_ip_hash text`** — the spec asks for a rate limit "by IP". Counting
  submissions needs something stable to count against. This is an HMAC of the
  address, never the address itself, so no raw IP is stored anywhere.

`author_email` is kept `not null` as specified. Replies you write from the
queue store `ADMIN_EMAIL`, or an empty string when it is unset.

`posts.search_vector` is a generated column rather than a plain one — Postgres
maintains it, so it cannot fall out of step with the row.

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
| `/api/posts/*`, `/api/pages/*` | every method, reads included |
| `/api/media`, `/api/series/*` | every method |
| `/api/comments/*` | every method **except** `POST /api/comments` |
| `POST /api/comments` | open — the one public write; lands as `pending` |
| `/media/*` | open — images must load in a browser without a cookie |
| `/preview/<token>` | open — the signed token *is* the credential |
| `/admin/login`, `/api/auth/*` | open |

Nothing under `/api` is open to a read any more, so there is no safe-method
exemption anywhere in `auth.ts`.

#### `GET /api/posts` used to be public. It should not have been.

The original reasoning was "reads stay open so the public site can use them".
That stopped being true once the public pages were built: they are server
components reading the database directly, and every remaining caller of this
API is in `src/components/admin`.

Meanwhile the open read returned drafts. `GET /api/posts?status=draft` listed
every unpublished post **in full** to anyone who asked — no id to guess — which
is the exact thing `/[slug]` goes out of its way to 404. It also made the
signed preview link pointless: there is no value in a capability token for
reading a draft if the plain list hands drafts out.

It is now gated like everything else, and sharing a draft goes through
[a preview link](#draft-preview-links).

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

## Design system

The public site follows [`Design.md`](Design.md) — editorial black and white,
one hot accent, condensed display type doing the heavy lifting.

### One system, measured

A UI audit found the design layer had drifted badly. What it looked like
before, and what it is now:

| | Before | After |
| --- | --- | --- |
| Uppercase label styles | 7, with 5 different tracking values | **1** (`.label`) |
| Button geometries | 5 (heights 17 / 23 / 38 / 41 / 54px) | **3** (pill, text, standard 40px) |
| Border-radius values | 7 (0, 4, 5, 6, 8, 999px, 50%) | **2** (pills, avatar) |

Specific things that were wrong:

- A post's title was condensed uppercase in the grid and serif on its own page
  — the same words in two faces.
- The post title was serif but its own `h2` subheadings were condensed
  uppercase, so the subheads shouted louder than the headline above them.
- Every card printed its date twice, once in the top row and again in the
  metadata row. §5 does list it twice, but that is an artefact of adapting the
  reference's byline credit line, and it reads as a bug.
- Commenters' names were rendered as 11px tracked-out capitals. A person's
  name is not a label.
- The middle column of the 3-up grid was narrower than its neighbours: gutters
  were padding, so the middle cell carried it on both sides while the outer
  cells carried one. Covers rendered at different heights and rows fell out of
  alignment. The gutter is now `column-gap` with the rule drawn as a
  pseudo-element inside it, so all three columns are identical.
- The homepage stated its tagline twice — once under the hero, once in the
  credit line under the frame.

### Tokens

Everything lives in `:root` in [`globals.css`](src/app/globals.css). No
component hardcodes a colour, so the palette moves from one place.

| Token | Value | Used for |
| --- | --- | --- |
| `--bg` | `#FFFFFF` | Page background |
| `--fg` | `#0A0A0A` | Text, hero type, borders, black canvas |
| `--fg-muted` | `#6B6B6B` | Dates, reading time, secondary text |
| `--border` | `#E5E5E5` | Hairline dividers |
| `--accent` | `#FF5A1F` | Active pill fill, hover, focus rings |
| `--accent-ink` | `#C93F08` | Links inside body copy |

**Why two oranges.** §2 asks to confirm the exact hex at implementation time.
`#FF5A1F` is 3.12:1 on white — fine for the 3:1 bar that non-text UI has to
clear, but short of the 4.5:1 that body text needs. So the hot orange stays the
brand accent for fills, hover and focus, and links inside prose use a darker
cut of the same hue at 5.0:1. Same colour family, no second hue introduced.

For the same reason the active pill sets **black** on orange (6.35:1), not
white (3.12:1).

### Type

Loaded with `next/font/local` from `src/fonts`, **not** `next/font/google`.
The Google loader fetches from fonts.googleapis.com at build time, so a build
on a machine or CI runner that cannot reach it fails outright — which is
exactly what happened here once the cached download was cleared. The eight
woff2 files (180 KB) are committed, and the build has no network dependency.

The `next/font` bindings are named `displayFace` / `uiFace` / `bodyFace`
because the loader derives the `@font-face` family name from the JS variable —
`const serif` produced a family literally called `serif`, shadowing the CSS
generic keyword.

| Role | Family | Why |
| --- | --- | --- |
| Hero and titles | **Anton** | §4 asks for "a true condensed-black cut, don't fake condensation via `letter-spacing` alone". Archivo Black — the prompt's fallback suggestion — is a black weight at *normal* width, so it would have meant faking it. Anton is genuinely condensed. |
| Nav, metadata, pills | **Inter** | Quiet, utilitarian, and it paints without drama at small sizes. |
| Body copy | **Source Serif 4** | Carried over from Phase 3 unchanged (§4, §9). |

All three are self-hosted through `next/font` — no request leaves the origin,
and they ship as static assets rather than Worker script.

The hero is sized with container-query units rather than a guessed `clamp`:
the wordmark measures 5.6em wide in Anton at this tracking, so `17.7cqw` fills
the column on a single line at every width from 375px up.

### Duotone covers

`filter: grayscale(1) contrast(1.12)`, applied through a single `.duotone`
class so every cover on every route gets it.

§2 specifies the two tones as `--fg` (near-black) and `--bg` (white) — and a
two-tone map between black and white *is* grayscale with a contrast curve.
There is no third colour for a true duotone to mix toward, so the more
elaborate SVG-filter approach would produce the same pixels. If the palette
ever gains a tinted shadow, that is the point to revisit it.

### Framing — dropped

Design.md §3 called for the homepage to float on a black canvas, with reading
pages on plain white. **That framing has been removed**: the whole public site
is one white page now.

It was the one part of the spec that fought the rest. The masthead already
carries the homepage on its own, and the frame put a hard border between the
homepage and every other page for no reason a reader benefits from.

With it gone the `(reading)` route group had nothing to separate — it held
every page — so it was collapsed and one layout serves the whole public site.

### Where the reference screenshots override Design.md

A later round of reference screenshots set a different direction for three
surfaces. The homepage still follows Design.md; these three follow the
screenshots:

- **Nav** — the wordmark is `topsailcashew`, one lowercase word in the serif,
  with Home / Stories / search on the left and the author block on the right.
  It reads as an identity mark, which is why it does not use the condensed
  display face the hero does.
- **Post page** — serif title rather than the condensed cut, a byline (which
  Design.md §9 had explicitly dropped for a single-author site), a **contained**
  cover rather than full-bleed, and a "Read Next" sidebar. §6 left the cover
  question open — "evaluate both at implementation time" — and the screenshot
  settles it.
- **Admin dashboard** — overview stats, quick draft, story table, comment queue
  and recent media, in panels.

The screenshots use a slate-teal for buttons. That was **not** adopted: a
second accent would fight Design.md §9's "one accent colour" and the homepage.
Primary buttons are `--fg` with the orange on hover.

### Decisions worth knowing

- **Category filtering is client-side over the current page.** No new API
  route, per the goal. That means it filters the twelve posts on screen, not
  the whole archive — so the empty state links to `/tag/[slug]`, which is the
  complete list.
- **Twelve posts a page**, up from ten, so the 3-column grid fills evenly
  rather than leaving a ragged final row.
- **The card shows the date twice** — once in the top row, once in the
  metadata row. That is §5 as written: the bottom row is the reference's credit
  line with the byline dropped (§9). It reads as redundant; say the word and
  the top-row date goes.
- **A post with no cover** degrades to a text-only card. §9 treats covers as
  required, so this is the degenerate case; the metadata row stays aligned with
  its neighbours, which leaves visible space where the image would be.
- **No dark mode**, per the goal and because §2 specifies a single light
  palette. The previous dark palette is gone, and since the admin shares these
  tokens it is now light-only too. If you want it back, it belongs scoped to
  the admin rather than reintroduced site-wide.
- **The admin was not restyled**, but it inherits the tokens, so it now renders
  in the neutral black/white/grey rather than the old warm palette. No admin
  markup or layout was touched.

### The masthead spotlight

Hovering the hero wordmark turns the letters under the cursor orange, with a
soft falloff into black either side.

It is two stacked copies of the word: black underneath, `--accent` on top,
masked to a radial gradient centred on the pointer. Masking the whole layer
rather than colouring individual letters is deliberate — the boundary can then
fall mid-glyph, so the light follows the cursor rather than snapping to the
letter grid.

- Only `--mx`/`--my` change on pointer move, so it is a paint on one composited
  layer, not a layout. Updates are coalesced into a `requestAnimationFrame`.
- **Touch and pen are ignored** (`pointerType !== "mouse"`), or a tap would
  light the mark and leave it lit with no pointer to move away.
- `@media (hover: none), (prefers-reduced-motion: reduce)` switches it off
  entirely. A spotlight chasing the cursor is exactly the movement that query
  is asking about.
- Without JavaScript, `--mx`/`--my` are never set, the accent layer stays at
  zero opacity, and what is left is the plain black wordmark.
- The heading carries an explicit `aria-label`. The word is in the DOM twice,
  and `aria-hidden` on the duplicate was **not** enough — the computed name came
  out as `topsailcashewtopsailcashew`, which is what a screen reader would have
  read aloud. Verified in the accessibility tree, not assumed.

---

## SEO and analytics

`sitemap.xml` and `robots.txt` are generated by Next's metadata routes
(`src/app/sitemap.ts`, `src/app/robots.ts`), so they are real cached responses
rather than static files that go stale. The sitemap lists the homepage, the
archive, every published post, every page, every series and every tag — read
through the same time-aware predicate as everything else, so a scheduled post
is absent until it is live.

Two details that would be easy to get wrong:

- `robots.txt` **omits** the `Sitemap:` line when `NEXT_PUBLIC_SITE_URL` is
  unset. A relative sitemap URL is invalid, and crawlers discard the whole file
  rather than the one bad line.
- The sitemap catches its own database errors and degrades to a
  homepage-only document. A `500` here teaches crawlers the file is broken; a
  short sitemap is recoverable on the next revalidate.
- `Disallow` covers `/admin`, `/api/`, `/preview/` and `/search`. None of that
  is what keeps them private — the first two are behind a session — it keeps
  them out of the index and stops crawlers spending the request budget on
  pages that only return `401`.

JSON-LD is built in `src/lib/structured-data.ts` and emitted by the `JsonLd`
component, which escapes `<` so a title containing `</script>` cannot close the
tag early. Everything in it is derived from fields already on the page; it is
not a second source of truth to keep in step.

**Analytics** is Cloudflare Web Analytics, gated on
`NEXT_PUBLIC_CF_ANALYTICS_TOKEN`. The beacon goes from the browser straight to
Cloudflare, so no request touches the Worker, the database or the request
budget. It sets no cookies and builds no cross-site profile, so there is
nothing to put a consent banner in front of. With the token unset, no analytics
code is emitted at all — a fork or a local run does not report into someone
else's dashboard.

---

## Comments

The only public write surface in the app, and the only place a stranger's input
reaches the database.

### How moderation works

1. A reader fills in the form at the bottom of a post — name, email, comment.
   No account, no login.
2. The comment is stored as **`pending`**. It is not on the page, not in the
   RSS feed, and not visible to anyone but you.
3. It appears in **`/admin/comments`**, which opens on the pending queue.
4. You **approve**, **reject**, or mark it **spam**. Approving drops the cached
   post page so the comment appears on the next request.
5. Rejected and spam comments are kept, not deleted, and stay filterable in the
   admin view.

Replies from the queue are published immediately and badged **Author** on the
page. They record `ADMIN_EMAIL` if it is set.

### What a reader can and cannot do

Submit, and nothing else. There are no commenter accounts, so there is no way
to authenticate someone as the author of an earlier comment — editing and
deleting are therefore not offered rather than offered insecurely.

Threads are **one level deep**. A reply aimed at a reply is re-parented to the
top-level comment, so a thread cannot grow arbitrarily deep.

If a parent comment is later hidden, its approved replies are promoted to top
level rather than vanishing — they were approved on their own merit, and
hiding them would silently delete moderated-in content.

### Spam handling

Two measures, which is the bar this phase set:

- **A honeypot field.** A `website` input, in the DOM but positioned off-screen
  and `aria-hidden`, that a person never sees and never fills. When it comes
  back filled the response is a normal `202` and nothing is written — a bot
  learns nothing from being caught. (It is off-screen rather than
  `display: none` because some automated clients skip fields that are not
  rendered at all.)
- **A per-address rate limit.** `COMMENT_RATE_LIMIT` submissions an hour,
  default 5, counted in Postgres so it is strongly consistent rather than
  eventually consistent.

No captcha. A paid anti-abuse service would be a dependency, a cost and a
third party seeing your readers' addresses, and none of that is justified
before there is actual spam to look at. If it becomes necessary, Cloudflare
Turnstile is free and sits at the edge — that is the thing to reach for, not a
comment-service SaaS.

**Not built, on purpose:** email notification of new comments. It needs an
email provider and a subscription model to be useful, and neither belongs in a
phase about reading. It is the obvious next addition.

### Addresses are hashed, not stored

Rate limiting has to recognise a repeat submitter; it does not need to know who
they are. The submitter's IP is HMAC-ed with `SESSION_SECRET` and only the
digest is stored, so the table is useless to anyone who reads it and rotating
the secret discards the history. Email addresses *are* stored in full — that is
the point of collecting them — and are never rendered on a public page. The
public comment shape has no email field at all, so it cannot leak by oversight.

---

## Series

A `series` table, and a nullable `series_id` on `posts`. A post belongs to at
most one.

Manage them at **`/admin/series`** — create, rename, delete — and assign one
from the Series dropdown in the post editor. Deleting a series does **not**
delete its posts; their `series_id` is nulled and they carry on as standalone
posts.

Publicly, `/series/[slug]` lists the parts in reading order, and a post that
belongs to one carries a "Part 2 of 5 · Series Title" line linking back.

Ordering and numbering come from `published_at`, counting published posts only.
So "Part 2" means the second one a reader saw, and a draft sitting in the
middle of a series does not silently shift every number after it. A series with
nothing published yet 404s rather than showing an empty page.

---

## Search

Postgres full-text search — no external service.

`posts.search_vector` is a **generated column**, maintained by Postgres itself,
so it cannot drift from the row the way a trigger or an application-maintained
column can. It is weighted:

| Weight | Source |
| --- | --- |
| A | title |
| B | excerpt |
| C | body, with HTML tags stripped |

so a title match outranks a passing mention in the body. A GIN index backs it.

`/search?q=` ranks with `ts_rank`. Queries go through `websearch_to_tsquery`,
which accepts what a reader would actually type — `"quoted phrases"`,
`-exclusions` — and treats stray operators as text instead of raising a syntax
error. An empty query invites one rather than listing everything; a query with
no matches says so. Results are `noindex`, since a search results page has no
business in someone else's index.

---

## Open Graph images

Cards are generated **at build time** into `public/og/<slug>.png` by
[`scripts/generate-og-images.ts`](scripts/generate-og-images.ts), and served as
static assets.

This is a deliberate departure from the obvious approach. Next's
`opengraph-image.tsx` renders on demand, which pulls satori and the resvg WASM
into the Worker bundle — measured at **3289 KiB gzipped against Cloudflare's
3072 KiB limit**, so the app would no longer deploy. Pre-rendering the route
only recovered 62 KiB; the renderer is bundled either way. Running the same
renderer in Node during the build produces the same images, ships them as
assets (which do not count toward the Worker limit), and costs nothing per
request.

The trade-off: a post published *after* a deploy has no card of its own until
the next build. The page lists the site-wide `/og/default.png` as a second
`og:image` for that window. `npm run build` regenerates them, so a redeploy
fixes it; on Cloudflare's paid plan (10 MiB) the built-in route becomes viable
again.

`scripts/assets/*.ttf` is Noto Serif, used only by that script — satori has no
access to CSS or system fonts, so the bytes have to be handed to it. Those
files never reach the Worker or the browser.

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
    (public)/layout.tsx             nav + footer for every public page
    (public)/page.tsx               home feed
    (public)/page/[page]/           older feed pages
    (public)/[slug]/page.tsx        the post
    (public)/tag/[tag]/page.tsx     posts by tag
    (public)/series/[slug]/page.tsx posts in a series, in reading order
    (public)/search/page.tsx        full-text search
    (public)/not-found.tsx          real 404 for drafts and unknown slugs
    rss.xml/route.ts                RSS 2.0
    admin/login/page.tsx            sign-in (outside the dashboard chrome)
    admin/(dashboard)/page.tsx      post list, filterable by status
    admin/(dashboard)/posts/[id]/   the editor; `new` is a special id
    admin/(dashboard)/comments/     moderation queue
    admin/(dashboard)/series/       series management
    api/posts/…                     post CRUD (Phase 1)
    api/auth/login|logout/          session in, session out
    api/media/route.ts              upload + recent uploads
    api/comments/                   public submission + moderation
    api/series/                     series management
    media/[...key]/route.ts         serves objects back out of R2
  components/
    public/PostList.tsx             feed layout, shared by home and tag pages
    public/PostMeta.tsx             date, reading time, tags
    public/Pagination.tsx           numbered pages
    public/Wordmark.tsx             display type, hero and post scale
    public/PostCard.tsx             one grid cell, per Design.md §5
    public/PostGrid.tsx             3-column grid with hairline dividers
    public/HomeFeed.tsx             category filter + the grid it controls
    public/SiteChrome.tsx           nav, canvas credit, reading footer
    public/CommentThread.tsx        approved comments, one level deep
    public/CommentForm.tsx          submission form with the honeypot
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
    comments.ts                     submission, threading, moderation
    series.ts                       series CRUD and part numbering
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
scripts/                            migrate.ts, smoke.sh,
                                    generate-og-images.ts
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

**Done — Phase 4.** Series grouping with public pages and per-post context ·
Postgres full-text search · build-time Open Graph cards · reader comments with
honeypot and rate limiting, a moderation queue, and author replies.

**Done — design pass.** `Design.md` implemented across the public routes:
black-canvas homepage framing, Anton hero wordmark, category filter, 3-column
hairline grid, duotone covers, restyled post and tag pages. See
[Design system](#design-system).

**Done — SEO, scheduling, revisions, previews, analytics.** `sitemap.xml` and
`robots.txt` · JSON-LD (`Blog` site-wide, `BlogPosting` per post, `WebPage` per
page) · time-aware publishing with no cron · capped, deduplicated revision
history with restore · signed expiring draft preview links · Cloudflare Web
Analytics behind an env flag · editable About/Newsletter/Contact pages · nav
reworked to About · Articles · Newsletter · Contact (`/stories` 308s to
`/articles`) · cursor spotlight on the masthead.

**Deliberately not built:** email notification of new comments · commenter
accounts · comment editing or deletion by the commenter · captcha. The first is
the natural next addition; the rest need an identity model this blog does not
have.

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
