"use client";

import { useState } from "react";
import { CommentForm } from "./CommentForm";

/** The reply affordance under a top-level comment. */
export function CommentReply({
  postId,
  parentId,
}: {
  postId: string;
  parentId: string;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        Reply
      </button>
    );
  }

  return (
    <div className="comment-reply-box">
      <CommentForm postId={postId} parentId={parentId} compact />
      <button type="button" className="link-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
