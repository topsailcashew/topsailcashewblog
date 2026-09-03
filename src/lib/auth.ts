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
 *   - POST /api/comments *exactly* — readers submit without an account; every
 *     submission lands as `pending` and is invisible until approved
 *   - POST /api/subscribe *exactly* — the newsletter signup form, same deal.
 *     Note the exact match: `startsWith("/api/subscribe")` would also open
 *     `/api/subscribers`, which is the whole audience list.
 *
 * Everything else a reader touches — confirmation and unsubscribe links, the
 * open pixel, the click redirect, the ActivityPub endpoints — is unlisted
 * here because it is not under a protected prefix at all. Each of those
 * carries its own signed token or its own signature check.
 */
function isPublic(pathname: string, method: string): boolean {
  if (pathname === "/admin/login") return true;
  if (pathname === "/api/auth/login" || pathname === "/api/auth/logout") return true;
  if (pathname === "/media" || pathname.startsWith("/media/")) return true;
  if (pathname === "/api/comments" && method === "POST") return true;
  if (pathname === "/api/subscribe" && method === "POST") return true;
  return false;
}

/**
 * Every API prefix that requires a session.
 *
 * One list, so adding an endpoint is one edit rather than two — and so the
 * test in tests/auth.test.ts can assert that `proxy.ts`'s matcher covers all
 * of them. A protected route missing from the matcher is not a broken route:
 * it is an open one, and it fails silently.
 */
export const PROTECTED_API_PREFIXES = [
  "/api/posts",
  "/api/pages",
  "/api/redirects",
  "/api/import",
  "/api/media",
  "/api/comments",
  "/api/series",
  "/api/subscribers",
  "/api/settings",
  "/api/newsletter",
] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isAdminRoute(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/**
 * Whether this request needs a session.
 *
 * `/admin/*` is gated for every method, as is every prefix above — there is no
 * safe-method exemption anywhere in this file. The public site reads the
 * database directly from server components and needs none of these.
 */
export function isProtected(pathname: string, method: string): boolean {
  if (isPublic(pathname, method)) return false;
  if (isAdminRoute(pathname)) return true;
  return PROTECTED_API_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
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
