import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { readConfirmToken } from "@/lib/email/tokens";
import { confirmSubscriber } from "@/lib/subscribers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm your subscription",
  // A confirmation URL contains a bearer token. It must never be indexed.
  robots: { index: false, follow: false },
};

/**
 * The other end of the double opt-in link.
 *
 * Confirming on GET is deliberate here, unlike unsubscribe: this link exists
 * for exactly one purpose, the reader asked for it, and a prefetch that
 * confirms an address the reader themselves typed in is the outcome they
 * wanted anyway.
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  const secret = getSessionSecret();
  const subscriberId = secret ? await readConfirmToken(t ?? null, secret) : null;

  const confirmed = subscriberId
    ? (await confirmSubscriber(getDb(), subscriberId)) !== null
    : false;

  return (
    <div className="shell-wrap notice" id="content">
      {confirmed ? (
        <>
          <h1>You are on the list</h1>
          <p>
            New writing will arrive when it is finished — no schedule, and
            nothing else. Every email carries an unsubscribe link that works.
          </p>
          <p>
            <Link href="/articles">Start reading →</Link>
          </p>
        </>
      ) : (
        <>
          <h1>That link did not work</h1>
          <p>
            Confirmation links expire after two weeks, and each one can only
            come from an email we sent. Subscribing again will send a fresh one.
          </p>
          <p>
            <Link href="/">Back to the writing</Link>
          </p>
        </>
      )}
    </div>
  );
}
