import Link from "next/link";
import { getDb } from "@/db/client";
import { POST_STATUSES, type PostStatus } from "@/db/schema";
import { listPosts, type SerializedPost } from "@/lib/posts";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ status?: string }>;

function parseStatus(value: string | undefined): PostStatus | undefined {
  return POST_STATUSES.includes(value as PostStatus)
    ? (value as PostStatus)
    : undefined;
}

export default async function AdminArticlesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { status } = await searchParams;
  const filter = parseStatus(status);

  let posts: SerializedPost[] = [];
  let error: string | null = null;
  try {
    posts = await listPosts(getDb(), { status: filter, limit: 100, offset: 0 });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Articles</h1>
        <div className="row filter-row">
          <FilterLink current={filter} value={undefined}>
            All
          </FilterLink>
          <FilterLink current={filter} value="draft">
            Drafts
          </FilterLink>
          <FilterLink current={filter} value="published">
            Published
          </FilterLink>
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!error && posts.length === 0 && (
        <p className="muted">
          Nothing here yet. <Link href="/admin/posts/new">Write the first post.</Link>
        </p>
      )}

      <ul className="post-rows">
        {posts.map((post) => (
          <li key={post.id}>
            <div className="post-row-head">
              <Link href={`/admin/posts/${post.id}`} className="post-row-title">
                {post.title}
              </Link>
              <span className={`status--${post.status}`}>
                {isScheduled(post) ? "scheduled" : post.status}
              </span>
            </div>
            <p className="meta">
              /{post.slug} ·{" "}
              {isScheduled(post)
                ? `goes live ${new Date(post.published_at!).toLocaleString()}`
                : `updated ${new Date(post.updated_at).toLocaleString()}`}
              {post.tags.length > 0 && ` · ${post.tags.map((tag) => tag.name).join(", ")}`}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}

/** Published, but dated forward — not yet visible to a reader. */
function isScheduled(post: SerializedPost): boolean {
  return (
    post.status === "published" &&
    post.published_at !== null &&
    new Date(post.published_at).getTime() > Date.now()
  );
}

function FilterLink({
  current,
  value,
  children,
}: {
  current: PostStatus | undefined;
  value: PostStatus | undefined;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <Link
      href={value ? `/admin/articles?status=${value}` : "/admin/articles"}
      className={active ? "tag-pill is-active" : "tag-pill"}
      aria-current={active ? "page" : undefined}
    >
      {children}
    </Link>
  );
}
