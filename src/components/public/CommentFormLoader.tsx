"use client";

import dynamic from "next/dynamic";

/**
 * The comment form is interactive-only — without JavaScript it cannot submit
 * anyway — so it is loaded on the client and kept out of the Worker bundle,
 * which has very little room left. The thread itself stays server-rendered, so
 * the comments are still in the HTML for readers and crawlers.
 */
const CommentForm = dynamic(
  () => import("./CommentForm").then((module) => module.CommentForm),
  { ssr: false, loading: () => <p className="muted">Loading the comment form…</p> },
);

const CommentReply = dynamic(
  () => import("./CommentReply").then((module) => module.CommentReply),
  { ssr: false },
);

export function LazyCommentForm(props: { postId: string }) {
  return <CommentForm {...props} />;
}

export function LazyCommentReply(props: { postId: string; parentId: string }) {
  return <CommentReply {...props} />;
}
