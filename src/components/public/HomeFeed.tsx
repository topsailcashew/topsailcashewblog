"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { PostSummary } from "@/lib/public-posts";
import { PostCard } from "./PostCard";

const ALL = "__all__";

/**
 * Category filter row plus the grid it controls (Design.md §5).
 *
 * Filtering is client-side over the posts already on the page — no extra
 * request, no new API route. That means it filters *this page* of the feed;
 * a tag's full archive lives at /tag/[slug], which the empty state links to
 * so the distinction never strands a reader.
 *
 * This is a client component, so it still server-renders: the cards are in the
 * HTML for readers and crawlers, and hydration only adds the filtering.
 */
export function HomeFeed({ posts }: { posts: PostSummary[] }) {
  const [active, setActive] = useState<string>(ALL);

  // Tags actually present on these posts, in first-seen order.
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const post of posts) {
      for (const tag of post.tags) {
        if (!seen.has(tag.slug)) seen.set(tag.slug, tag.name);
      }
    }
    return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
  }, [posts]);

  const visible = useMemo(
    () =>
      active === ALL
        ? posts
        : posts.filter((post) => post.tags.some((tag) => tag.slug === active)),
    [posts, active],
  );

  const activeName = categories.find((c) => c.slug === active)?.name;

  return (
    <>
      {categories.length > 0 && (
        <div className="categories">
          <span className="label">Categories</span>
          <div className="categories-pills" role="group" aria-label="Filter by category">
            <button
              type="button"
              className={active === ALL ? "tag-pill is-active" : "tag-pill"}
              aria-pressed={active === ALL}
              onClick={() => setActive(ALL)}
            >
              All
            </button>
            {categories.map((category) => (
              <button
                key={category.slug}
                type="button"
                className={active === category.slug ? "tag-pill is-active" : "tag-pill"}
                aria-pressed={active === category.slug}
                onClick={() => setActive(category.slug)}
              >
                {category.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="grid-empty">
          Nothing on this page is tagged {activeName ?? "that"}.{" "}
          {active !== ALL && (
            <Link href={`/tag/${active}`}>See everything tagged {activeName}.</Link>
          )}
        </div>
      ) : (
        <div className="grid">
          {visible.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      )}
    </>
  );
}
