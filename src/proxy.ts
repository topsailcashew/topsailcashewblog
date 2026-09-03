import { NextResponse, type NextRequest } from "next/server";
import { authorize, isProtected } from "@/lib/auth";

/**
 * Next 16's proxy (formerly `middleware.ts`) — the one place auth is enforced.
 *
 * API routes get a JSON error; page routes are redirected to the login form
 * with a `?next=` pointing back at where they were headed.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!isProtected(pathname, request.method)) {
    return NextResponse.next();
  }

  const result = await authorize(request);
  if (result.ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }

  const loginUrl = new URL("/admin/login", request.url);
  loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

/*
  Must stay in step with PROTECTED_API_PREFIXES in src/lib/auth.ts — a prefix
  that is gated there but missing here never reaches the proxy at all, so it is
  simply open, with nothing to notice. Next requires this to be a static
  literal, so it cannot be derived from that list; tests/auth.test.ts asserts
  the two agree instead.
*/
export const config = {
  matcher: [
    "/admin/:path*",
    "/api/posts/:path*",
    "/api/pages/:path*",
    "/api/redirects/:path*",
    "/api/import/:path*",
    "/api/media/:path*",
    "/api/comments/:path*",
    "/api/series/:path*",
    "/api/subscribers/:path*",
    "/api/settings/:path*",
    "/api/newsletter/:path*",
  ],
};
