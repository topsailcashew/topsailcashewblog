import Link from "next/link";
import { getDb } from "@/db/client";
import { CommentActions } from "@/components/admin/CommentActions";
import {
  COMMENT_STATUSES,
  countByStatus,
  listForModeration,
  type CommentStatus,
} from "@/lib/comments";
import { formatDate } from "@/lib/site";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ status?: string }>;

function parseStatus(value: string | undefined): CommentStatus | undefined {
  return COMMENT_STATUSES.includes(value as CommentStatus)
    ? (value as CommentStatus)
    : undefined;
}

export default async function CommentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { status } = await searchParams;
  // Default to the queue that needs attention rather than everything.
  const filter = parseStatus(status) ?? (status === "all" ? undefined : "pending");

  const db = getDb();
  let comments: Awaited<ReturnType<typeof listForModeration>> = [];
  let counts = { pending: 0, approved: 0, rejected: 0, spam: 0 };
  let error: string | null = null;

  try {
    [comments, counts] = await Promise.all([
      listForModeration(db, filter),
      countByStatus(db),
    ]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Comments</h1>
        <div className="row filter-row">
          <FilterLink current={filter} value="pending" count={counts.pending}>
            Pending
          </FilterLink>
          <FilterLink current={filter} value="approved" count={counts.approved}>
            Approved
          </FilterLink>
          <FilterLink current={filter} value="rejected" count={counts.rejected}>
            Rejected
          </FilterLink>
          <FilterLink current={filter} value="spam" count={counts.spam}>
            Spam
          </FilterLink>
          <Link
            href="/admin/comments?status=all"
            className={filter === undefined ? "tag-pill is-active" : "tag-pill"}
          >
            All
          </Link>
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!error && comments.length === 0 && (
        <p className="muted">
          {filter === "pending"
            ? "Nothing waiting. The queue is clear."
            : "No comments with that status."}
        </p>
      )}

      <ul className="post-rows">
        {comments.map((comment) => (
          <li key={comment.id}>
            <div className="post-row-head">
              <span className="mini-name">{comment.author_name}</span>
              {/*
                A federated reply is moderated in the same queue as one typed
                into the page — that is the point of accepting them — but the
                moderator has to be able to tell them apart. A remote handle is
                an identity nobody here verified, and there is no address to
                reply to.
              */}
              {comment.source === "fediverse" && (
                <span className="badge badge--fediverse">fediverse</span>
              )}
              <span className={`status--${comment.status === "approved" ? "published" : "draft"}`}>{comment.status}</span>
            </div>
            <p className="meta">
              {/* Shown to the moderator only — never rendered publicly. */}
              {comment.source === "fediverse" ? (
                <a href={comment.remote_actor_uri ?? "#"} rel="noopener noreferrer nofollow">
                  {comment.remote_actor_uri}
                </a>
              ) : (
                comment.author_email
              )}{" · "}
              {formatDate(comment.created_at)}
              {comment.parent_id && " · reply"}
              {comment.is_author && " · your reply"}
              {comment.post && (
                <>
                  {" · on "}
                  <Link href={`/${comment.post.slug}`}>{comment.post.title}</Link>
                </>
              )}
            </p>
            {/* Rendered as text: comment bodies are untrusted input. */}
            <p className="comment-text">{comment.body}</p>
            <CommentActions commentId={comment.id} status={comment.status} />
          </li>
        ))}
      </ul>
    </main>
  );
}

function FilterLink({
  current,
  value,
  count,
  children,
}: {
  current: CommentStatus | undefined;
  value: CommentStatus;
  count: number;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <Link
      href={`/admin/comments?status=${value}`}
      className={active ? "tag-pill is-active" : "tag-pill"}
      aria-current={active ? "page" : undefined}
    >
      {children} {count > 0 && <span className="pill-count">{count}</span>}
    </Link>
  );
}
