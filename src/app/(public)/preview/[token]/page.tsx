import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { Article } from "@/components/public/Article";
import { getSessionSecret } from "@/lib/auth";
import { getPostById } from "@/lib/posts";
import { verifyPreviewToken } from "@/lib/preview";
import { getSeriesContext } from "@/lib/series";

/**
 * A draft, readable by anyone holding a valid link.
 *
 * Deliberately its own route rather than a `?preview=` parameter on `/[slug]`:
 * reading a search param would make the post page dynamic for every visitor
 * and cost the whole site its static rendering. Here the dynamic rendering is
 * confined to a route nobody reaches without a token.
 */
export const dynamic = "force-dynamic";

/** Never indexed, never cached — this is unpublished writing. */
export const metadata: Metadata = {
  title: "Preview",
  robots: { index: false, follow: false, nocache: true },
};

type Params = Promise<{ token: string }>;

export default async function PreviewPage({ params }: { params: Params }) {
  const { token } = await params;

  const secret = getSessionSecret();
  if (!secret) notFound();

  const postId = await verifyPreviewToken(token, secret);
  // An invalid, tampered or expired token is a 404, not a message explaining
  // which — there is nothing useful to tell someone who does not hold a link.
  if (!postId) notFound();

  const db = getDb();
  const post = await getPostById(db, postId);
  if (!post) notFound();

  const seriesContext = await getSeriesContext(db, {
    id: post.id,
    seriesId: post.series_id,
  });

  return (
    /* The centred layout, not the post page's grid — there is no Read Next
       rail on a preview, and reserving the column for one leaves the article
       sitting noticeably left of centre. */
    <div className="page-layout shell-wrap" id="content">
      <div className="preview-banner" role="status">
        <span className="label">Preview</span>
        <span>
          {post.status === "published"
            ? "This post is live."
            : "This is an unpublished draft. The link expires on its own."}
        </span>
      </div>
      <Article post={post} seriesContext={seriesContext} />
    </div>
  );
}
