import type { Metadata } from "next";
import Link from "next/link";
import { getSessionSecret } from "@/lib/auth";
import { readUnsubscribeToken } from "@/lib/email/tokens";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
};

/**
 * The unsubscribe confirmation.
 *
 * This page never unsubscribes anyone; the button posts to `/e/u`, which does.
 * Mail clients, link scanners and corporate security proxies all fetch the
 * URLs in an email before a human sees them, and a page that acted on GET
 * would quietly remove readers who never clicked.
 *
 * One button, no survey, no "are you sure" beyond this. Making it hard is how
 * you convert an unsubscribe into a spam complaint.
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; done?: string }>;
}) {
  const { t, done } = await searchParams;

  if (done === "1") {
    return (
      <div className="shell-wrap notice" id="content">
        <h1>Unsubscribed</h1>
        <p>
          That address is off the list. Nothing further will be sent to it, and
          the writing stays here to read whenever you want it.
        </p>
        <p>
          <Link href="/articles">Back to the articles</Link>
        </p>
      </div>
    );
  }

  const secret = getSessionSecret();
  const valid = secret ? (await readUnsubscribeToken(t ?? null, secret)) !== null : false;

  if (!valid) {
    return (
      <div className="shell-wrap notice" id="content">
        <h1>That link did not work</h1>
        <p>
          The unsubscribe link has to come from one of our emails. If you are
          still getting mail you did not ask for, reply to any of it and it will
          be dealt with by hand.
        </p>
        <p>
          <Link href="/">Back to the writing</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="shell-wrap notice" id="content">
      <h1>Unsubscribe?</h1>
      <p>
        One button, and you are off the list. No survey, and nothing to confirm
        afterwards.
      </p>
      <form method="post" action={`/e/u?t=${encodeURIComponent(t ?? "")}`}>
        <button type="submit" className="btn btn--primary">
          Unsubscribe
        </button>
      </form>
      <p>
        <Link href="/articles">Changed your mind? Keep reading →</Link>
      </p>
    </div>
  );
}
