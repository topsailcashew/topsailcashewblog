import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { posts } from "@/db/schema";
import {
  getSeriesPosts,
  listPublishedSeriesSlugs,
  searchPublished,
} from "@/lib/public-posts";
import {
  createSeries,
  deleteSeries,
  getSeriesContext,
  listSeries,
  updateSeries,
} from "@/lib/series";
import { db, hasDatabase, resetTables, setupDatabase, teardownDatabase } from "./helpers";

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

async function seedPost(options: {
  title: string;
  slug: string;
  html?: string;
  excerpt?: string;
  status?: "draft" | "published";
  publishedAt?: Date;
  seriesId?: string | null;
}) {
  const [row] = await db()
    .insert(posts)
    .values({
      title: options.title,
      slug: options.slug,
      excerpt: options.excerpt ?? null,
      contentHtml: options.html ?? "<p>Body.</p>",
      status: options.status ?? "published",
      publishedAt: options.status === "draft" ? null : (options.publishedAt ?? new Date()),
      seriesId: options.seriesId ?? null,
    })
    .returning();
  return row;
}

describe(
  "series",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("numbers parts by publication date, not insertion order", async () => {
      const s = await createSeries(db(), { title: "In Order" });
      const last = await seedPost({ title: "Third", slug: "third", publishedAt: day(30), seriesId: s.id });
      const first = await seedPost({ title: "First", slug: "first", publishedAt: day(10), seriesId: s.id });
      const middle = await seedPost({ title: "Second", slug: "second", publishedAt: day(20), seriesId: s.id });

      for (const [row, part] of [[first, 1], [middle, 2], [last, 3]] as const) {
        const context = await getSeriesContext(db(), { id: row.id, seriesId: s.id });
        assert.equal(context?.part, part, `${row.title} should be part ${part}`);
        assert.equal(context?.total, 3);
      }
    });

    it("does not let a draft shift the numbering", async () => {
      const s = await createSeries(db(), { title: "With A Draft" });
      await seedPost({ title: "One", slug: "one", publishedAt: day(10), seriesId: s.id });
      await seedPost({ title: "Hidden", slug: "hidden", status: "draft", seriesId: s.id });
      const third = await seedPost({ title: "Two", slug: "two", publishedAt: day(20), seriesId: s.id });

      const context = await getSeriesContext(db(), { id: third.id, seriesId: s.id });
      assert.equal(context?.part, 2);
      assert.equal(context?.total, 2);
    });

    it("returns no context for a post outside any series", async () => {
      const row = await seedPost({ title: "Alone", slug: "alone" });
      assert.equal(await getSeriesContext(db(), { id: row.id, seriesId: null }), null);
    });

    it("lists series pages only when something published is in them", async () => {
      const live = await createSeries(db(), { title: "Live One" });
      const empty = await createSeries(db(), { title: "Empty One" });
      await seedPost({ title: "P", slug: "p", seriesId: live.id });
      await seedPost({ title: "D", slug: "d", status: "draft", seriesId: empty.id });

      const slugs = await listPublishedSeriesSlugs(db());
      assert.deepEqual(slugs, ["live-one"]);
      assert.deepEqual((await getSeriesPosts(db(), "empty-one")).posts, []);
    });

    it("gives colliding titles distinct slugs", async () => {
      const a = await createSeries(db(), { title: "Same Name" });
      const b = await createSeries(db(), { title: "Same Name" });
      assert.equal(a.slug, "same-name");
      assert.equal(b.slug, "same-name-2");
    });

    it("counts only published posts per series", async () => {
      const s = await createSeries(db(), { title: "Counted" });
      await seedPost({ title: "Live", slug: "live", seriesId: s.id });
      await seedPost({ title: "Draft", slug: "draft", status: "draft", seriesId: s.id });

      const [entry] = await listSeries(db());
      assert.equal(entry.post_count, 1);
    });

    it("renaming keeps the same row", async () => {
      const s = await createSeries(db(), { title: "Old Name" });
      const renamed = await updateSeries(db(), s.id, { title: "New Name" });
      assert.equal(renamed.id, s.id);
      assert.equal(renamed.title, "New Name");
    });

    it("deleting a series frees its posts rather than removing them", async () => {
      const s = await createSeries(db(), { title: "Doomed" });
      const post = await seedPost({ title: "Survivor", slug: "survivor", seriesId: s.id });

      await deleteSeries(db(), s.id);

      const [after] = await db().select().from(posts);
      assert.equal(after.id, post.id, "the post should still exist");
      assert.equal(after.seriesId, null, "its series link should be cleared");
    });
  },
);

describe(
  "search",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(resetTables);

    it("matches on title, excerpt and body", async () => {
      await seedPost({ title: "Kingfisher Notes", slug: "a" });
      await seedPost({ title: "B", slug: "b", excerpt: "About the heron" });
      await seedPost({ title: "C", slug: "c", html: "<p>A passage mentioning cormorants.</p>" });

      assert.deepEqual((await searchPublished(db(), "kingfisher")).results.map((r) => r.slug), ["a"]);
      assert.deepEqual((await searchPublished(db(), "heron")).results.map((r) => r.slug), ["b"]);
      assert.deepEqual((await searchPublished(db(), "cormorants")).results.map((r) => r.slug), ["c"]);
    });

    it("ranks a title match above a body-only match", async () => {
      await seedPost({ title: "Body mention", slug: "body", html: "<p>estuary</p>" });
      await seedPost({ title: "Estuary", slug: "title", html: "<p>unrelated</p>" });

      const { results } = await searchPublished(db(), "estuary");
      assert.deepEqual(results.map((r) => r.slug), ["title", "body"]);
    });

    it("never returns a draft", async () => {
      await seedPost({ title: "Secret kingfisher", slug: "secret", status: "draft" });
      assert.deepEqual((await searchPublished(db(), "kingfisher")).results, []);
    });

    it("ignores markup so a tag name is not a search term", async () => {
      await seedPost({ title: "Plain", slug: "plain", html: '<p class="blockquote">text</p>' });
      assert.deepEqual((await searchPublished(db(), "blockquote")).results, []);
    });

    it("returns nothing for an empty or whitespace query", async () => {
      await seedPost({ title: "Anything", slug: "anything" });
      assert.deepEqual((await searchPublished(db(), "")).results, []);
      assert.deepEqual((await searchPublished(db(), "   ")).results, []);
    });

    it("survives punctuation a reader might type", async () => {
      await seedPost({ title: "Quoted", slug: "quoted", html: "<p>exact phrase here</p>" });
      // websearch_to_tsquery treats these as syntax rather than erroring.
      for (const query of ['"exact phrase"', "phrase -nothing", "((("]) {
        await assert.doesNotReject(() => searchPublished(db(), query), `query: ${query}`);
      }
    });
  },
);
