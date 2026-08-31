/**
 * The single authorization checkpoint for the whole app.
 *
 * Every protected route goes through `proxy.ts`, which calls `authorize()`
 * below. Route handlers contain no auth checks of their own — if something
 * needs protecting, it belongs in `isProtected()` here, not in the handler.
 */
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./session";

export { safeRedirectPath } from "./redirect";

export type AuthResult =
  | { ok: true; subject: string }
  | { ok: false; status: 401 | 403 | 500; message: string };

/*
  `GET /api/posts` used to be open, on the reasoning that "reads stay open so
  the public site can use them". That stopped being true once the public pages
  were built: they are server components reading the database directly, and
  every caller of this API is in src/components/admin. Meanwhile the open read
  returned drafts — `?status=draft` listed every unpublished post in full to
  anyone who asked, which is the exact thing the public routes go out of their
  way to 404. Draft sharing goes through a signed preview link instead
  (src/lib/preview.ts).

  With that gone, nothing under /api is open to a read any more — so there is
  no longer a safe-method exemption anywhere in this file. Every API route is
  gated for every method except the two named in isPublic below.
*/

/**
 * Routes that stay reachable without a session:
 *   - the login page and the endpoints that grant/clear a session
 *   - /media/* — uploaded images must load in a browser without a cookie
 *   - POST /api/comments *exactly* — the one public write in the app. Readers
 *     submit without an account; every submission lands as `pending` and is
 *     invisible until approved. Nothing else under /api/comments is open:
 *     listing and moderation both require a session.
 */
function isPublic(pathname: string, method: string): boolean {
  if (pathname === "/admin/login") return true;
  if (pathname === "/api/auth/login" || pathname === "/api/auth/logout") return true;
  if (pathname === "/media" || pathname.startsWith("/media/")) return true;
  if (pathname === "/api/comments" && method === "POST") return true;
  return false;
}

function isPostsApi(pathname: string): boolean {
  return pathname === "/api/posts" || pathname.startsWith("/api/posts/");
}

function isPagesApi(pathname: string): boolean {
  return pathname === "/api/pages" || pathname.startsWith("/api/pages/");
}

function isAdminRoute(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function isMediaApi(pathname: string): boolean {
  return pathname === "/api/media" || pathname.startsWith("/api/media/");
}

function isCommentsApi(pathname: string): boolean {
  return pathname === "/api/comments" || pathname.startsWith("/api/comments/");
}

function isSeriesApi(pathname: string): boolean {
  return pathname === "/api/series" || pathname.startsWith("/api/series/");
}

/**
 * Whether this request needs a session.
 *
 * `/admin/*` is gated for every method; the JSON APIs are gated for mutations
 * only. Media upload is gated outright — there is no read side to it.
 */
export function isProtected(pathname: string, method: string): boolean {
  if (isPublic(pathname, method)) return false;
  return (
    isAdminRoute(pathname) ||
    isPostsApi(pathname) ||
    isPagesApi(pathname) ||
    isMediaApi(pathname) ||
    isCommentsApi(pathname) ||
    isSeriesApi(pathname)
  );
}

export function getSessionSecret(): string | undefined {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length > 0 ? secret : undefined;
}

export async function authorize(request: NextRequest): Promise<AuthResult> {
  const secret = getSessionSecret();
  if (!secret) {
    // Failing closed matters here: without a secret every cookie would verify.
    console.error("SESSION_SECRET is not set — refusing all admin requests.");
    return {
      ok: false,
      status: 500,
      message: "Server is missing SESSION_SECRET",
    };
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token, secret);
  if (!session) {
    return { ok: false, status: 401, message: "Sign in to continue" };
  }

  return { ok: true, subject: session.subject };
}
