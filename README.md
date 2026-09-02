# topsailcashew

Essays, notes, and long-form writing by Nathaniel Senje.

**Read it at [topsailcashew-blog.topsailcashew.workers.dev](https://topsailcashew-blog.topsailcashew.workers.dev)**

---

## What this is

A personal blog. One writer, no feed algorithm, no newsletter popup on arrival,
nothing that follows you around the page. Pieces are published when they are
finished and stay where they were put.

The writing is long-form by default — set in a serif, one column, about 680
pixels wide, because that is what a paragraph wants to be read in. Everything
around the words is deliberately quiet: black and white, one hot orange for
the things you can click, and photographs treated as gallery pieces rather
than decoration.

## Getting around

| | |
|---|---|
| **[Articles](https://topsailcashew-blog.topsailcashew.workers.dev/articles)** | Everything, newest first. |
| **Series** | Pieces written to be read in order, numbered and linked to each other. |
| **Tags** | Every article carries a few; each one has its own page. |
| **Search** | Full-text across titles, summaries and body copy. |
| **[About](https://topsailcashew-blog.topsailcashew.workers.dev/about)** | Who is writing and why. |
| **[Contact](https://topsailcashew-blog.topsailcashew.workers.dev/contact)** | How to get in touch. |
| **[RSS](https://topsailcashew-blog.topsailcashew.workers.dev/rss.xml)** | The whole feed, for a reader of your choosing. |

Articles are open to comments. They are read before they appear, so there is a
wait — the trade for a comment section worth reading. Your email address is
asked for so there is a way to reply to you, and it is never shown on the page.

## A note on the feed

There is an RSS feed and it is not an afterthought. If you want to follow
along, that is the way to do it that does not involve an account, a
recommendation engine, or anyone selling your attention. Point any reader at
[`/rss.xml`](https://topsailcashew-blog.topsailcashew.workers.dev/rss.xml).

## Under the hood

The blog is its own software rather than a hosted platform — written in
TypeScript on Next.js, running at the edge on Cloudflare Workers, with Postgres
for the words and R2 for the pictures. Pages are pre-rendered, so they arrive
quickly from wherever you happen to be.

If you are here for that side of it, the engineering record lives in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the data model, the
publishing and scheduling rules, how drafts stay private, what the deployment
actually does, and a running list of the decisions that were not obvious at the
time.

## Reuse

The code is public so it can be read and learned from. The writing is not
public domain: posts, drafts and images are © Nathaniel Senje. Quote a piece
with attribution and a link, by all means — but please do not republish one
whole.
