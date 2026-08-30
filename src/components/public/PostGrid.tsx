import type { PostSummary } from "@/lib/public-posts";
import { PostCard } from "./PostCard";

/**
 * The 3-column grid with hairlines on both axes (Design.md §5).
 *
 * Dividers come from a 1px gap over a border-coloured background, so adjacent
 * cells share one hairline instead of doubling it where two borders meet.
 * Collapses 3 → 2 → 1 in CSS.
 */
export function PostGrid({
  posts,
  empty,
}: {
  posts: PostSummary[];
  empty?: React.ReactNode;
}) {
  if (posts.length === 0) {
    return <div className="grid-empty">{empty ?? "Nothing published yet."}</div>;
  }

  return (
    <div className="grid">
      {posts.map((post) => (
        <PostCard key={post.slug} post={post} />
      ))}
    </div>
  );
}
