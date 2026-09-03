import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getSessionSecret } from "@/lib/auth";
import { readClickToken } from "@/lib/email/tokens";
import { recordClick } from "@/lib/newsletter";
import { absoluteUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * The click redirect.
 *
 * The destination is *inside* the signed token, never in a query parameter.
 * A `/e/c?url=` endpoint would be an open redirect on the blog's own domain —
 * the single most useful thing a phisher can borrow from a site with any
 * reputation. Here the only reachable destinations are URLs this blog itself
 * put into an email it sent.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const secret = getSessionSecret();
  const { token } = await context.params;
  const payload = secret ? await readClickToken(token, secret) : null;

  if (!payload || !/^https?:\/\//.test(payload.u)) {
    return NextResponse.redirect(absoluteUrl("/"), 302);
  }

  try {
    await recordClick(getDb(), payload.d, payload.u);
  } catch (error) {
    // The reader is mid-click. Losing the statistic beats losing the link.
    console.warn("Could not record a click:", error);
  }

  return NextResponse.redirect(payload.u, {
    status: 302,
    headers: { "cache-control": "no-store" },
  });
}
