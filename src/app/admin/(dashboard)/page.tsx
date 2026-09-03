import Link from "next/link";
import { getDb } from "@/db/client";
import { CommentActions } from "@/components/admin/CommentActions";
import { GrowthChart } from "@/components/admin/GrowthChart";
import { PostRowActions } from "@/components/admin/PostRowActions";
import { PostStatusBadge } from "@/components/admin/PostStatusBadge";
import { QuickDraft } from "@/components/admin/QuickDraft";
import { countByStatus, listForModeration } from "@/lib/comments";
import { altTextFor, listMedia } from "@/lib/media";
import {
  getPostEmailPerformance,
  getRollingAverage,
  type PostEmailPerformance,
  type RollingAverage,
} from "@/lib/newsletter";
import { countPostsByStatus, listPosts, type SerializedPost } from "@/lib/posts";
import { formatDate } from "@/lib/site";
import {
  countSubscribersByStatus,
  getGrowthSeries,
  type GrowthPoint,
  type SubscriberCounts,
} from "@/lib/subscribers";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const db = getDb();

  let posts: SerializedPost[] = [];
  let postCounts = { published: 0, draft: 0, trash: 0 };
  let commentCounts = { pending: 0, approved: 0, rejected: 0, spam: 0 };
  let pendingComments: Awaited<ReturnType<typeof listForModeration>> = [];
  let media: Awaited<ReturnType<typeof listMedia>> = [];
  let subscriberCounts: SubscriberCounts = {
    pending: 0,
    subscribed: 0,
    unsubscribed: 0,
    bounced: 0,
    complained: 0,
    total: 0,
  };
  let growth: GrowthPoint[] = [];
  let rolling: RollingAverage = { campaigns: 0, open_rate: null, ctor: null };
  let performance = new Map<string, PostEmailPerformance>();
  let error: string | null = null;

  try {
    [posts, postCounts, commentCounts, pendingComments, media, subscriberCounts, growth, rolling] =
      await Promise.all([
        listPosts(db, { limit: 8, offset: 0 }),
        countPostsByStatus(db),
        countByStatus(db),
        listForModeration(db, "pending", 4),
        listMedia(db, 9),
        countSubscribersByStatus(db),
        getGrowthSeries(db, 30),
        getRollingAverage(db, 10),
      ]);

    // Depends on the post list, so it cannot join the batch above.
    performance = await getPostEmailPerformance(
      db,
      posts.map((post) => post.id),
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  const anyEmailData = performance.size > 0;

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

      {/*
        Counts run the full width as one strip rather than sitting in a boxed
        panel beside the quick-draft form. Numbers do not need a container of
        their own, and pairing them with a text form made a short panel stretch
        to match a tall one, leaving half of it empty.
      */}
      <div className="stat-strip">
        <Stat label="Articles" value={postCounts.published} href="/admin/articles?status=published" />
        <Stat label="Drafts" value={postCounts.draft} href="/admin/articles?status=draft" />
        <Stat
          label="Subscribers"
          value={subscriberCounts.subscribed}
          href="/admin/subscribers"
        />
        <Stat label="Comments" value={commentCounts.approved} href="/admin/comments?status=approved" />
        <Stat label="Pending" value={commentCounts.pending} href="/admin/comments" />
        {postCounts.trash > 0 && (
          <Stat label="Trash" value={postCounts.trash} href="/admin/articles?status=trash" />
        )}
      </div>

      {/*
        The chart earns the space above the fold only once there is an audience
        to plot. On a blog with no subscribers it would be thirty empty slots
        where the writing should be.
      */}
      {subscriberCounts.total > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h2 className="label">Audience · 30 days</h2>
            <Link href="/admin/subscribers" className="panel-more">
              The whole list →
            </Link>
          </div>
          <GrowthChart points={growth} />
        </div>
      )}

      <div className="dashboard-grid">
        <div className="dashboard-main">
          <div className="panel">
            <div className="panel-head">
              <h2 className="label">Recent articles</h2>
              <Link href="/admin/articles" className="panel-more">
                All articles →
              </Link>
            </div>

            {anyEmailData && (
              <p className="hint">
                Rates are measured against the last {rolling.campaigns} send
                {rolling.campaigns === 1 ? "" : "s"} — {percent(rolling.open_rate)} opened,{" "}
                {percent(rolling.ctor)} of those clicked. An absolute open rate
                means little; the movement against your own baseline is the part
                worth reading.
              </p>
            )}

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
                      {anyEmailData && <th scope="col">Opens</th>}
                      {anyEmailData && <th scope="col">CTOR</th>}
                      <th scope="col">Last Modified</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {posts.map((post) => {
                      const email = performance.get(post.id);
                      return (
                        <tr key={post.id}>
                          <td>
                            <Link href={`/admin/posts/${post.id}`}>{post.title}</Link>
                          </td>
                          <td>
                            <PostStatusBadge post={post} />
                          </td>
                          {anyEmailData && (
                            <td>
                              <RateCell value={email?.open_rate} baseline={rolling.open_rate} />
                            </td>
                          )}
                          {anyEmailData && (
                            <td>
                              <RateCell value={email?.ctor} baseline={rolling.ctor} />
                            </td>
                          )}
                          <td>{formatDate(post.updated_at)}</td>
                          <td>
                            <PostRowActions id={post.id} title={post.title} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <aside className="dashboard-aside">
          {/* Secondary: a shortcut, not the main event — "Write" is in the nav. */}
          <QuickDraft />

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
            <h2 className="label">
              <Link href="/admin/media">Recent media</Link>
            </h2>
            {media.length === 0 ? (
              <p className="muted">No uploads yet.</p>
            ) : (
              <div className="media-grid">
                {media.map((item) => (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={item.id}
                    src={item.url}
                    alt={altTextFor(item)}
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

/**
 * A rate, with how it compares to the rolling baseline.
 *
 * The delta is what carries the meaning, so it is what gets the colour. A bare
 * "38%" tells you nothing unless you already know what this list normally
 * does — and the person reading this screen has better things to remember.
 */
function RateCell({
  value,
  baseline,
}: {
  value: number | null | undefined;
  baseline: number | null;
}) {
  if (value === null || value === undefined) {
    return <span className="muted">—</span>;
  }

  const delta = baseline === null ? null : value - baseline;
  // Under a point either way is noise on a list this size, not a signal.
  const direction = delta === null || Math.abs(delta) < 0.01 ? "flat" : delta > 0 ? "up" : "down";

  return (
    <span className="rate-cell">
      <span className="rate-value">{Math.round(value * 100)}%</span>
      {delta !== null && (
        <span className={`rate-delta rate-delta--${direction}`}>
          {direction === "flat"
            ? "on par"
            : `${delta > 0 ? "+" : "−"}${Math.abs(Math.round(delta * 100))}`}
        </span>
      )}
    </span>
  );
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
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
