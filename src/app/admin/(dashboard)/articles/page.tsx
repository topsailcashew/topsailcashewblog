import Link from "next/link";
import { getDb } from "@/db/client";
import { EmptyTrashButton } from "@/components/admin/EmptyTrashButton";
import { PostRowActions } from "@/components/admin/PostRowActions";
import { countPostsByStatus, listPosts, type SerializedPost } from "@/lib/posts";
import { POST_LIST_FILTERS, type PostListFilter } from "@/lib/validation";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ status?: string }>;

function parseFilter(value: string | undefined): PostListFilter | undefined {
  return POST_LIST_FILTERS.includes(value as PostListFilter)
    ? (value as PostListFilter)
    : undefined;
}

export default async function AdminArticlesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { status } = await searchParams;
  const filter = parseFilter(status);
  const inTrash = filter === "trash";

  let posts: SerializedPost[] = [];
  let counts = { published: 0, draft: 0, trash: 0 };
  let error: string | null = null;
  try {
    const db = getDb();
    [posts, counts] = await Promise.all([
      listPosts(db, { status: filter, limit: 100, offset: 0 }),
      countPostsByStatus(db),
    ]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">{inTrash ? "Trash" : "Articles"}</h1>
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
          {/* Only offered once there is something in it. */}
          {counts.trash > 0 && (
            <FilterLink current={filter} value="trash">
              Trash ({counts.trash})
            </FilterLink>
          )}
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {inTrash && (
        <div className="trash-bar">
          <p className="hint">
            Trashed posts are hidden from the site but keep their tags,
            comments and version history. Their URLs stay reserved, so
            restoring brings a post back to its own address.
          </p>
          <EmptyTrashButton count={counts.trash} />
        </div>
      )}

      {!error && posts.length === 0 && (
        <p className="muted">
          {inTrash ? (
            "The trash is empty."
          ) : (
            <>
              Nothing here yet.{" "}
              <Link href="/admin/posts/new">Write the first post.</Link>
            </>
          )}
        </p>
      )}

      <ul className="post-rows">
        {posts.map((post) => (
          <li key={post.id}>
            <div className="post-row-head">
              {inTrash ? (
                <span className="post-row-title">{post.title}</span>
              ) : (
                <Link href={`/admin/posts/${post.id}`} className="post-row-title">
                  {post.title}
                </Link>
              )}
              <span className={`status--${inTrash ? "draft" : post.status}`}>
                {inTrash ? "trashed" : isScheduled(post) ? "scheduled" : post.status}
              </span>
              <PostRowActions id={post.id} title={post.title} trashed={inTrash} />
            </div>
            <p className="meta">
              /{post.slug} ·{" "}
              {inTrash
                ? `trashed ${new Date(post.deleted_at!).toLocaleString()}`
                : isScheduled(post)
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
  current: PostListFilter | undefined;
  value: PostListFilter | undefined;
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
