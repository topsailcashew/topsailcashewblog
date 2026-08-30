"use client";

import { useState, useTransition } from "react";
import type { SerializedPost } from "@/lib/posts";

/**
 * The smallest thing that proves the API works end to end: create a post,
 * flip it between draft and published, delete it. The Tiptap editor replaces
 * this in Phase 2.
 */
export function PostList({ initialPosts }: { initialPosts: SerializedPost[] }) {
  const [posts, setPosts] = useState(initialPosts);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function refresh() {
    const response = await fetch("/api/posts");
    const body = (await response.json()) as { posts?: SerializedPost[] };
    setPosts(body.posts ?? []);
  }

  function run(action: () => Promise<Response>) {
    startTransition(async () => {
      setError(null);
      const response = await action();
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${response.status})`);
        return;
      }
      await refresh();
    });
  }

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          run(async () => {
            const response = await fetch("/api/posts", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title }),
            });
            if (response.ok) setTitle("");
            return response;
          });
        }}
      >
        <div className="row">
          <input
            aria-label="New post title"
            placeholder="New post title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            style={{ flex: 1, minWidth: "16rem" }}
          />
          <button type="submit" disabled={pending || !title.trim()}>
            Create draft
          </button>
        </div>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {posts.length === 0 ? (
        <p className="muted">No posts yet.</p>
      ) : (
        posts.map((post) => (
          <article key={post.id} className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2>{post.title}</h2>
              <span className="pill">{post.status}</span>
            </div>
            <p className="muted">
              /{post.slug}
              {post.tags.length > 0 && ` · ${post.tags.map((t) => t.name).join(", ")}`}
            </p>
            <div className="row">
              <button
                disabled={pending}
                onClick={() =>
                  run(() =>
                    fetch(`/api/posts/${post.id}`, {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        status: post.status === "published" ? "draft" : "published",
                      }),
                    }),
                  )
                }
              >
                {post.status === "published" ? "Unpublish" : "Publish"}
              </button>
              <button
                disabled={pending}
                onClick={() =>
                  run(() => fetch(`/api/posts/${post.id}`, { method: "DELETE" }))
                }
              >
                Delete
              </button>
            </div>
          </article>
        ))
      )}
    </>
  );
}
