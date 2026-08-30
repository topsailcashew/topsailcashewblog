import Link from "next/link";
import { getDb } from "@/db/client";
import { CommentActions } from "@/components/admin/CommentActions";
import { PostRowActions } from "@/components/admin/PostRowActions";
import { QuickDraft } from "@/components/admin/QuickDraft";
import { countByStatus, listForModeration } from "@/lib/comments";
import { listMedia } from "@/lib/media";
import { countPostsByStatus, listPosts, type SerializedPost } from "@/lib/posts";
import { formatDate } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const db = getDb();

  let posts: SerializedPost[] = [];
  let postCounts = { published: 0, draft: 0 };
  let commentCounts = { pending: 0, approved: 0, rejected: 0, spam: 0 };
  let pendingComments: Awaited<ReturnType<typeof listForModeration>> = [];
  let media: Awaited<ReturnType<typeof listMedia>> = [];
  let error: string | null = null;

  try {
    [posts, postCounts, commentCounts, pendingComments, media] = await Promise.all([
      listPosts(db, { limit: 8, offset: 0 }),
      countPostsByStatus(db),
      countByStatus(db),
      listForModeration(db, "pending", 4),
      listMedia(db, 9),
    ]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Dashboard</h1>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="dashboard-grid">
        <div className="dashboard-main">
          <div className="panel-row">
            <div className="panel">
              <h2 className="label">Overview</h2>
              <div className="stat-grid">
                <Stat label="Stories" value={postCounts.published} href="/admin/stories?status=published" />
                <Stat label="Drafts" value={postCounts.draft} href="/admin/stories?status=draft" />
                <Stat label="Comments" value={commentCounts.approved} href="/admin/comments?status=approved" />
                <Stat label="Pending" value={commentCounts.pending} href="/admin/comments" />
              </div>
            </div>

            <QuickDraft />
          </div>

          <div className="panel">
            <h2 className="label">Recent stories</h2>
            {posts.length === 0 ? (
              <p className="muted">
                Nothing yet. <Link href="/admin/posts/new">Write the first one.</Link>
              </p>
            ) : (
              <div className="table-scroll">
                <table className="story-table">
                  <thead>
                    <tr>
                      <th scope="col">Title</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last Modified</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {posts.map((post) => (
                      <tr key={post.id}>
                        <td>
                          <Link href={`/admin/posts/${post.id}`}>{post.title}</Link>
                        </td>
                        <td>
                          <span className={`status--${post.status}`}>
                            {post.status}
                          </span>
                        </td>
                        <td>{formatDate(post.updated_at)}</td>
                        <td>
                          <PostRowActions id={post.id} title={post.title} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <aside className="dashboard-aside">
          <div className="panel">
            <h2 className="label">Awaiting moderation</h2>
            {pendingComments.length === 0 ? (
              <p className="muted">Nothing waiting. The queue is clear.</p>
            ) : (
              <ul className="mini-list">
                {pendingComments.map((comment) => (
                  <li key={comment.id}>
                    <span className="mini-name">{comment.author_name}</span>
                    {comment.post && (
                      <Link href={`/${comment.post.slug}`} className="mini-context">
                        {comment.post.title}
                      </Link>
                    )}
                    {/* Reader input, rendered as text. */}
                    <p className="mini-body">{comment.body}</p>
                    <CommentActions commentId={comment.id} status={comment.status} />
                  </li>
                ))}
              </ul>
            )}
            <Link href="/admin/comments" className="panel-more">
              All comments →
            </Link>
          </div>

          <div className="panel">
            <h2 className="label">Recent media</h2>
            {media.length === 0 ? (
              <p className="muted">No uploads yet.</p>
            ) : (
              <div className="media-grid">
                {media.map((item) => (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={item.id}
                    src={item.url}
                    alt={item.alt_text ?? ""}
                    loading="lazy"
                  />
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link href={href} className="stat">
      <span className="label">{label}</span>
      <span className="stat-value">{value}</span>
    </Link>
  );
}
