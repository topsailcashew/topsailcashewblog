import { getDb } from "@/db/client";
import { listPosts, type SerializedPost } from "@/lib/posts";
import { PostList } from "./post-list";

// Reads Postgres per request. Phase 3 replaces this with the static public
// feed and moves the admin view under /admin.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  let posts: SerializedPost[] = [];
  let error: string | null = null;

  try {
    posts = await listPosts(getDb(), { limit: 50, offset: 0 });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  return (
    <main>
      <h1>Posts</h1>
      <p className="muted">
        Phase 1 scaffold — unstyled on purpose. Exercises the same API the editor
        will use.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <PostList initialPosts={posts} />
      )}
    </main>
  );
}
