import type { PublicComment } from "@/lib/comments";
import { formatDate } from "@/lib/site";
import { LazyCommentForm, LazyCommentReply } from "./CommentFormLoader";

/**
 * Approved comments, one level of replies.
 *
 * Bodies are rendered as text, never as HTML — `white-space: pre-wrap` keeps
 * the writer's line breaks without giving a stranger a way to inject markup
 * into the page. Email addresses are not part of `PublicComment` at all.
 */
export function CommentThread({
  postId,
  comments,
}: {
  postId: string;
  comments: PublicComment[];
}) {
  const total = comments.reduce((sum, c) => sum + 1 + c.replies.length, 0);

  return (
    <section className="comments" id="comments" aria-labelledby="comments-heading">
      <h2 id="comments-heading" className="label">
        {total === 0 ? "Comments" : `${total} ${total === 1 ? "comment" : "comments"}`}
      </h2>

      {comments.length === 0 ? (
        <p className="muted">No comments yet. Yours would be the first.</p>
      ) : (
        <ol className="comment-list">
          {comments.map((comment) => (
            <li key={comment.id} className="comment">
              <CommentBody comment={comment} />
              <LazyCommentReply postId={postId} parentId={comment.id} />

              {comment.replies.length > 0 && (
                <ol className="comment-replies">
                  {comment.replies.map((reply) => (
                    <li key={reply.id} className="comment">
                      <CommentBody comment={reply} />
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ol>
      )}

      <LazyCommentForm postId={postId} />
    </section>
  );
}

function CommentBody({ comment }: { comment: PublicComment }) {
  return (
    <>
      <div className="comment-meta">
        <span className="comment-author">{comment.author_name}</span>
        {comment.is_author && <span className="comment-badge">Author</span>}
        <span className="meta-dot" aria-hidden="true">
          ·
        </span>
        <time dateTime={comment.created_at}>{formatDate(comment.created_at)}</time>
      </div>
      <p className="comment-text">{comment.body}</p>
    </>
  );
}
