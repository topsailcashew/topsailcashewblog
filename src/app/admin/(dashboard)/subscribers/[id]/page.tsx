import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { SubscriberRowActions } from "@/components/admin/SubscriberRowActions";
import { formatDate } from "@/lib/site";
import {
  getSubscriber,
  getSubscriberMetrics,
  getSubscriberTimeline,
  serializeSubscriber,
  type TimelineEntry,
} from "@/lib/subscribers";

export const dynamic = "force-dynamic";

/**
 * One reader's whole relationship with the blog.
 *
 * Two halves, because they answer different questions. The aggregates say
 * whether this person is still reading; the feed says what they actually did
 * and when — which is the only thing that explains an aggregate that looks
 * wrong.
 */
export default async function SubscriberProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();

  const row = await getSubscriber(db, id);
  if (!row) notFound();

  const subscriber = serializeSubscriber(row);
  const [metrics, timeline] = await Promise.all([
    getSubscriberMetrics(db, id),
    getSubscriberTimeline(db, id, 100),
  ]);

  return (
    <main className="admin-main">
      <div className="admin-head">
        <div>
          <p className="label">
            <Link href="/admin/subscribers">← Audience</Link>
          </p>
          <h1 className="admin-title">{subscriber.email}</h1>
          <p className="meta-inline">
            <span className={`badge badge--${subscriber.status}`}>{subscriber.status}</span>
            {subscriber.name && <> · {subscriber.name}</>} · joined{" "}
            {formatDate(subscriber.created_at)}
          </p>
        </div>
        <SubscriberRowActions id={subscriber.id} email={subscriber.email} />
      </div>

      <div className="stat-strip">
        <Metric label="Delivered" value={String(metrics.delivered)} />
        <Metric
          label="Open rate"
          value={percent(metrics.open_rate)}
          detail={`${metrics.opened} of ${metrics.delivered}`}
        />
        <Metric
          label="CTOR"
          value={percent(metrics.ctor)}
          detail={`${metrics.clicked} of ${metrics.opened} opened`}
        />
        <Metric
          label="Total opens"
          value={String(metrics.total_opens)}
          detail={`${metrics.total_clicks} clicks`}
        />
        {metrics.failed > 0 && (
          <Metric label="Failed" value={String(metrics.failed)} detail="delivery errors" />
        )}
      </div>

      <div className="dashboard-grid">
        <div className="dashboard-main">
          <div className="panel">
            <h2 className="label">Activity</h2>
            {timeline.length === 0 ? (
              <p className="muted">Nothing recorded yet.</p>
            ) : (
              <ol className="timeline">
                {timeline.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} />
                ))}
              </ol>
            )}
          </div>
        </div>

        <aside className="dashboard-aside">
          <div className="panel">
            <h2 className="label">How they arrived</h2>
            <dl className="detail-list">
              <Detail term="Source" value={subscriber.utm_source ?? subscriber.referrer_host} />
              <Detail term="Medium" value={subscriber.utm_medium} />
              <Detail term="Campaign" value={subscriber.utm_campaign} />
              <Detail term="Term" value={subscriber.utm_term} />
              <Detail term="Content" value={subscriber.utm_content} />
              <Detail term="Referrer" value={subscriber.referrer_host} />
              <Detail
                term="Signed up on"
                value={subscriber.landing_path}
                href={subscriber.landing_path ?? undefined}
              />
              <Detail
                term="Confirmed"
                value={subscriber.confirmed_at ? formatDate(subscriber.confirmed_at) : null}
              />
              <Detail
                term="Unsubscribed"
                value={
                  subscriber.unsubscribed_at ? formatDate(subscriber.unsubscribed_at) : null
                }
              />
            </dl>
          </div>
        </aside>
      </div>
    </main>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  return (
    <li className={`timeline-row timeline-row--${entry.type}`}>
      <span className="timeline-type">{TYPE_LABELS[entry.type] ?? entry.type}</span>
      <span className="timeline-body">
        {entry.campaign && <span className="timeline-subject">{entry.campaign.subject}</span>}
        {entry.url && (
          <a href={entry.url} className="timeline-url" target="_blank" rel="noopener noreferrer">
            {entry.url}
          </a>
        )}
      </span>
      <time className="timeline-when" dateTime={entry.created_at}>
        {new Date(entry.created_at).toLocaleString()}
      </time>
    </li>
  );
}

const TYPE_LABELS: Record<string, string> = {
  subscribed: "Signed up",
  confirmed: "Confirmed",
  unsubscribed: "Unsubscribed",
  sent: "Sent",
  opened: "Opened",
  clicked: "Clicked",
  bounced: "Bounced",
  complained: "Complained",
};

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="stat stat--static">
      <span className="label">{label}</span>
      <span className="stat-value">{value}</span>
      {detail && <span className="stat-detail">{detail}</span>}
    </div>
  );
}

function Detail({
  term,
  value,
  href,
}: {
  term: string;
  value: string | null;
  href?: string;
}) {
  // A row of em-dashes for every field nobody filled in is noise. Absent
  // attribution is the normal case, and the interesting thing is what *is* set.
  if (!value) return null;
  return (
    <>
      <dt>{term}</dt>
      <dd>{href ? <Link href={href}>{value}</Link> : value}</dd>
    </>
  );
}

/** Null means "no denominator", which is not the same as zero. */
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
