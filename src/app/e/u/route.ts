import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { readUnsubscribeToken } from "@/lib/email/tokens";
import { absoluteUrl } from "@/lib/site";
import { unsubscribeSubscriber } from "@/lib/subscribers";

export const dynamic = "force-dynamic";

/**
 * Unsubscribe, for both kinds of caller.
 *
 * POST is RFC 8058 one-click: the mail client sends it when the reader presses
 * the unsubscribe control the client itself renders, with no browser involved.
 * That control only appears when List-Unsubscribe-Post is present, and it is
 * the difference between a reader unsubscribing and a reader pressing "report
 * spam" — which is the same outcome for them and a much worse one for the
 * sending domain.
 *
 * GET is a person clicking the link in the footer, and it deliberately does
 * *not* unsubscribe: mail clients and security scanners prefetch links, and a
 * GET that acted would remove people who never clicked anything. It hands off
 * to a page with a button, which posts back here.
 */
export async function POST(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("t");
  const done = await apply(token);

  // A mail client wants a plain 200 and reads nothing; a browser arriving from
  // the confirmation page's form wants to land somewhere it can read.
  if ((request.headers.get("accept") ?? "").includes("text/html")) {
    return NextResponse.redirect(
      absoluteUrl(`/newsletter/unsubscribe?t=${encodeURIComponent(token ?? "")}&done=${done ? "1" : "0"}`),
      303,
    );
  }
  return new Response(null, { status: 200 });
}

export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  return NextResponse.redirect(
    absoluteUrl(`/newsletter/unsubscribe?t=${encodeURIComponent(token)}`),
    302,
  );
}

async function apply(token: string | null): Promise<boolean> {
  const secret = getSessionSecret();
  if (!secret || !token) return false;

  const subscriberId = await readUnsubscribeToken(token, secret);
  if (!subscriberId) return false;

  try {
    return (await unsubscribeSubscriber(getDb(), subscriberId)) !== null;
  } catch (error) {
    console.warn("Could not unsubscribe:", error);
    return false;
  }
}
