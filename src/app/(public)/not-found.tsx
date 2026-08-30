import Link from "next/link";

/** Rendered with a real 404 status for unknown slugs, drafts, and empty tags. */
export default function NotFound() {
  return (
    <div className="wrap notice">
      <h1>Not found</h1>
      <p>
        There is nothing published at this address. It may have been moved, or
        never have been public.
      </p>
      <p>
        <Link href="/">Back to all posts</Link>
      </p>
    </div>
  );
}
