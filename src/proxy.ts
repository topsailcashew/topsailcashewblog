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

export const config = {
  matcher: [
    "/admin/:path*",
    "/api/posts/:path*",
    "/api/pages/:path*",
    "/api/media/:path*",
    "/api/comments/:path*",
    "/api/series/:path*",
  ],
};
