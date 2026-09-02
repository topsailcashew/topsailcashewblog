import type { SerializedPost } from "@/lib/posts";

/**
 * The status a writer cares about, which is not quite the stored one.
 *
 * "Scheduled" is `published` with a future date — the column has no such
 * value. The dashboard used to print the raw status, so a post nobody could
 * read yet was labelled "published"; the articles list computed it separately.
 * One component now, used by both.
 */
export function postStatusLabel(post: SerializedPost, now = Date.now()): string {
  if (post.deleted_at !== null) return "trashed";
  if (
    post.status === "published" &&
    post.published_at !== null &&
    new Date(post.published_at).getTime() > now
  ) {
    return "scheduled";
  }
  return post.status;
}

export function PostStatusBadge({ post }: { post: SerializedPost }) {
  const label = postStatusLabel(post);
  return <span className={`status--${label}`}>{label}</span>;
}
