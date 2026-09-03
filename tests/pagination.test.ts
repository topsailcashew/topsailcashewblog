import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createPost } from "@/lib/posts";
import { createSeries } from "@/lib/series";
import {
  POSTS_PER_PAGE,
  SEARCH_LIMIT,
  countPublished,
  getFeed,
  getSeriesPosts,
  listPublishedSeries,
  searchPublished,
} from "@/lib/public-posts";
import {
  db,
  hasDatabase,
  resetTables,
  setupDatabase,
  teardownDatabase,
} from "./helpers";

/** Publishes `count` posts, oldest first, so ordering is deterministic. */
async function seedPosts(
  count: number,
  options: { tags?: string[]; seriesId?: string; prefix?: string } = {},
) {
  const prefix = options.prefix ?? "post";
  const created = [];
  for (let index = 0; index < count; index += 1) {
    created.push(
      await createPost(db(), {
        title: `${prefix} ${String(index).padStart(2, "0")}`,
        content_html: `<p>Body of ${prefix} ${index}.</p>`,
        status: "published",
        // Spaced a day apart so newest-first is unambiguous.
        published_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        tags: options.tags,
        series_id: options.seriesId,
      }),
    );
  }
  return created;
}

describe(
  "paginated archives",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("splits the feed into pages that do not overlap", async () => {
      await seedPosts(POSTS_PER_PAGE + 5);

      const first = await getFeed(db(), 1);
      const second = await getFeed(db(), 2);

      assert.equal(first.posts.length, POSTS_PER_PAGE);
      assert.equal(second.posts.length, 5);
      assert.equal(first.totalPosts, POSTS_PER_PAGE + 5);
      assert.equal(first.totalPages, 2);

      const slugs = new Set([...first.posts, ...second.posts].map((p) => p.slug));
      assert.equal(slugs.size, POSTS_PER_PAGE + 5, "a post appeared on both pages");
    });

    it("paginates a tag, which used to cap silently at one page", async () => {
      // The bug this replaces: /tag/x printed the true total and rendered 12,
      // with no pager at all, so the rest was unreachable.
      await seedPosts(POSTS_PER_PAGE + 3, { tags: ["Letters"] });
      await seedPosts(2, { tags: ["Other"], prefix: "other" });

      const page1 = await getFeed(db(), 1, { tag: "letters" });
      const page2 = await getFeed(db(), 2, { tag: "letters" });

      assert.equal(page1.totalPosts, POSTS_PER_PAGE + 3);
      assert.equal(page1.posts.length, POSTS_PER_PAGE);
      assert.equal(page2.posts.length, 3);
      assert.ok(
        [...page1.posts, ...page2.posts].every((p) => p.title.startsWith("post")),
        "a post from another tag leaked in",
      );
    });

    it("filters by series, and the count agrees with the page", async () => {
      const one = await createSeries(db(), { title: "First Run" });
      const two = await createSeries(db(), { title: "Second Run" });
      await seedPosts(3, { seriesId: one.id, prefix: "one" });
      await seedPosts(2, { seriesId: two.id, prefix: "two" });

      const feed = await getFeed(db(), 1, { series: one.slug });
      assert.equal(feed.totalPosts, 3);
      assert.ok(feed.posts.every((p) => p.title.startsWith("one")));
      assert.equal(await countPublished(db(), { series: two.slug }), 2);
    });

    it("composes a tag and a series filter without double-counting", async () => {
      /*
        The reason these are EXISTS clauses rather than joins: a post carries
        several tags, so joining twice would return it once per matching row
        and the count would disagree with the page.
      */
      const run = await createSeries(db(), { title: "Run" });
      await seedPosts(2, { seriesId: run.id, tags: ["Letters", "Craft"] });
      await seedPosts(2, { seriesId: run.id, tags: ["Other"], prefix: "other" });

      const feed = await getFeed(db(), 1, { series: run.slug, tag: "letters" });
      assert.equal(feed.totalPosts, 2);
      assert.equal(feed.posts.length, 2);
      assert.equal(
        await countPublished(db(), { series: run.slug, tag: "letters" }),
        2,
        "count disagreed with the page",
      );
    });

    it("keeps a series in reading order across pages", async () => {
      const run = await createSeries(db(), { title: "Long Run" });
      await seedPosts(POSTS_PER_PAGE + 2, { seriesId: run.id, prefix: "part" });

      const page1 = await getSeriesPosts(db(), run.slug, 1);
      const page2 = await getSeriesPosts(db(), run.slug, 2);

      assert.equal(page1.totalPosts, POSTS_PER_PAGE + 2);
      // Ascending: part 00 leads, unlike every other feed.
      assert.equal(page1.posts[0].title, "part 00");
      assert.equal(page2.posts[0].title, `part ${POSTS_PER_PAGE}`);
      assert.equal(page2.posts.length, 2);
    });

    it("returns an empty page past the end rather than wrapping round", async () => {
      await seedPosts(3);
      const beyond = await getFeed(db(), 99);
      assert.deepEqual(beyond.posts, []);
      // The route turns this into a 404; the query must not silently serve
      // page 1 instead.
      assert.equal(beyond.page, 99);
    });

    it("treats a nonsense page number as page one", async () => {
      await seedPosts(2);
      for (const page of [0, -3, Number.NaN]) {
        assert.equal((await getFeed(db(), page)).page, 1, `page ${page}`);
      }
    });
  },
);

describe(
  "search paging",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("reports the true total, not the number of rows it fetched", async () => {
      // The bug: the page printed `{results.length} results`, so a query
      // matching 30 posts said "25 results" and offered no way to the rest.
      await seedPosts(SEARCH_LIMIT + 5, { prefix: "estuary" });

      const page1 = await searchPublished(db(), "estuary", 1);
      assert.equal(page1.total, SEARCH_LIMIT + 5);
      assert.equal(page1.results.length, SEARCH_LIMIT);
      assert.equal(page1.totalPages, 2);

      const page2 = await searchPublished(db(), "estuary", 2);
      assert.equal(page2.results.length, 5);

      const slugs = new Set([...page1.results, ...page2.results].map((r) => r.slug));
      assert.equal(slugs.size, SEARCH_LIMIT + 5);
    });

    it("does not page into the fuzzy fallback from an exhausted query", async () => {
      /*
        The trigram fallback is a different result set with a different
        ordering. Running it for page 2 of a query that legitimately matched
        nothing would swap one result set for another mid-navigation.
      */
      await seedPosts(2, { prefix: "estuary" });
      const page2 = await searchPublished(db(), "qwertyuiop", 2);
      assert.deepEqual(page2.results, []);
      assert.equal(page2.total, 0);
    });
  },
);

describe(
  "public series listing",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("counts only what a reader can open", async () => {
      /*
        `listSeries` in src/lib/series.ts counts `status = 'published'`, which
        includes a scheduled post. On a public filter bar that would advertise
        a count nobody can reach — and a series whose only post is scheduled
        would be a link straight to a 404.
      */
      const run = await createSeries(db(), { title: "Mixed" });
      await createPost(db(), {
        title: "Live one",
        status: "published",
        published_at: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        series_id: run.id,
      });
      await createPost(db(), {
        title: "Scheduled one",
        status: "published",
        published_at: new Date(Date.now() + 86_400_000).toISOString(),
        series_id: run.id,
      });
      await createPost(db(), { title: "A draft", status: "draft", series_id: run.id });

      const [entry] = await listPublishedSeries(db());
      assert.equal(entry.count, 1, "a scheduled or draft post was counted");
    });

    it("omits a series with nothing published", async () => {
      const empty = await createSeries(db(), { title: "Nothing Yet" });
      await createPost(db(), { title: "Only a draft", status: "draft", series_id: empty.id });
      assert.deepEqual(await listPublishedSeries(db()), []);
    });
  },
);
