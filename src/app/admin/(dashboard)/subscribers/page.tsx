import Link from "next/link";
import { getDb } from "@/db/client";
import { GrowthChart } from "@/components/admin/GrowthChart";
import { SubscriberRowActions } from "@/components/admin/SubscriberRowActions";
import { loadNewsletterSettings } from "@/lib/email/config";
import { formatDate } from "@/lib/site";
import {
  countSubscribers,
  countSubscribersByStatus,
  getAcquisitionSources,
  getGrowthSeries,
  listSubscribers,
  type AcquisitionSource,
  type GrowthPoint,
  type SerializedSubscriber,
  type SubscriberCounts,
} from "@/lib/subscribers";
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from "@/db/schema";
import { AdminPager, parsePage } from "@/components/admin/AdminPager";

/** Addresses are one short row each. */
const PER_PAGE = 50;

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ status?: string; q?: string; page?: string }>;

function parseStatus(value: string | undefined): SubscriberStatus | undefined {
  return SUBSCRIBER_STATUSES.includes(value as SubscriberStatus)
    ? (value as SubscriberStatus)
    : undefined;
}

export default async function AdminSubscribersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { status, q, page } = await searchParams;
  const filter = parseStatus(status);
  const currentPage = parsePage(page);

  let rows: SerializedSubscriber[] = [];
  let counts: SubscriberCounts = {
    pending: 0,
    subscribed: 0,
    unsubscribed: 0,
    bounced: 0,
    complained: 0,
    total: 0,
  };
  let growth: GrowthPoint[] = [];
  let sources: AcquisitionSource[] = [];
  let newsletterOn = false;
  let matching = 0;
  let error: string | null = null;

  try {
    const db = getDb();
    [rows, counts, growth, sources, newsletterOn, matching] = await Promise.all([
      listSubscribers(db, {
        status: filter,
        search: q,
        limit: PER_PAGE,
        offset: (currentPage - 1) * PER_PAGE,
      }),
      countSubscribersByStatus(db),
      getGrowthSeries(db, 30),
      getAcquisitionSources(db),
      loadNewsletterSettings(db).then((settings) => settings.enabled),
      countSubscribers(db, { status: filter, search: q }),
    ]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Audience</h1>
        <form className="row filter-row" method="get">
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search addresses"
            aria-label="Search subscribers"
          />
          {filter && <input type="hidden" name="status" value={filter} />}
          <button type="submit" className="btn btn--small">
            Search
          </button>
        </form>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!newsletterOn && !error && (
        <p className="notice-inline">
          The newsletter is switched off, so the signup form does not appear on
          the site and sends will refuse.{" "}
          <Link href="/admin/settings">Turn it on in Settings →</Link>
        </p>
      )}

      <div className="stat-strip">
        <Stat label="Confirmed" value={counts.subscribed} filter="subscribed" current={filter} />
        <Stat label="Pending" value={counts.pending} filter="pending" current={filter} />
        <Stat label="Unsubscribed" value={counts.unsubscribed} filter="unsubscribed" current={filter} />
        {counts.bounced + counts.complained > 0 && (
          <Stat
            label="Suppressed"
            value={counts.bounced + counts.complained}
            filter="bounced"
            current={filter}
          />
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2 className="label">Growth · 30 days</h2>
          {filter && (
            <Link href="/admin/subscribers" className="panel-more">
              Clear filter ×
            </Link>
          )}
        </div>
        <GrowthChart points={growth} />
      </div>

      <div className="dashboard-grid">
        <div className="dashboard-main">
          <div className="panel">
            <h2 className="label">
              {filter ? `${filter} · ${matching}` : `Everyone · ${matching}`}
            </h2>
            {rows.length === 0 ? (
              <p className="muted">
                {q ? `Nothing matches “${q}”.` : "No signups yet."}
              </p>
            ) : (
              <div className="table-scroll">
                <table className="story-table">
                  <thead>
                    <tr>
                      <th scope="col">Address</th>
                      <th scope="col">Status</th>
                      <th scope="col">Source</th>
                      <th scope="col">Joined</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <Link href={`/admin/subscribers/${row.id}`}>{row.email}</Link>
                          {row.name && <span className="meta-inline">{row.name}</span>}
                        </td>
                        <td>
                          <span className={`badge badge--${row.status}`}>{row.status}</span>
                        </td>
                        <td>
                          <span className="meta-inline">
                            {row.utm_source ?? row.referrer_host ?? "direct"}
                          </span>
                        </td>
                        <td>{formatDate(row.created_at)}</td>
                        <td>
                          <SubscriberRowActions id={row.id} email={row.email} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <AdminPager
              page={currentPage}
              total={matching}
              perPage={PER_PAGE}
              basePath="/admin/subscribers"
              params={{ status, q }}
              noun="subscribers"
            />
          </div>
        </div>

        <aside className="dashboard-aside">
          <div className="panel">
            <h2 className="label">Where they came from</h2>
            {sources.length === 0 ? (
              <p className="muted">
                Nothing to attribute yet. Tag a link with{" "}
                <code>?utm_source=</code> and it will show up here.
              </p>
            ) : (
              <ul className="source-list">
                {sources.map((source) => (
                  <li key={`${source.label}-${source.medium}-${source.campaign}`}>
                    <span className="source-label">{source.label}</span>
                    <span className="source-count">{source.count}</span>
                    {/*
                      On its own row beneath both, so a long hostname gets the
                      full width instead of being broken mid-word by a count
                      sitting beside it. Signups are cheap; the confirmations
                      are the number that means something.
                    */}
                    <span className="meta-inline source-meta">
                      {[
                        ...(source.medium ? [source.medium] : []),
                        ...(source.campaign ? [source.campaign] : []),
                        `${source.confirmed} confirmed`,
                      ].join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  filter,
  current,
}: {
  label: string;
  value: number;
  filter: SubscriberStatus;
  current: SubscriberStatus | undefined;
}) {
  const href =
    current === filter ? "/admin/subscribers" : `/admin/subscribers?status=${filter}`;
  return (
    <Link href={href} className={current === filter ? "stat is-current" : "stat"}>
      <span className="label">{label}</span>
      <span className="stat-value">{value}</span>
    </Link>
  );
}
