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

/** Methods that only read. Everything else is treated as a mutation. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Routes that stay reachable without a session:
 *   - the login page and the endpoints that grant/clear a session
 *   - GET /api/posts — reads stay open so the Phase 3 public site can use them
 *   - /media/* — uploaded images must load in a browser without a cookie
 */
function isPublic(pathname: string, method: string): boolean {
  if (pathname === "/admin/login") return true;
  if (pathname === "/api/auth/login" || pathname === "/api/auth/logout") return true;
  if (pathname === "/media" || pathname.startsWith("/media/")) return true;
  if (isPostsApi(pathname) && SAFE_METHODS.has(method)) return true;
  return false;
}

function isPostsApi(pathname: string): boolean {
  return pathname === "/api/posts" || pathname.startsWith("/api/posts/");
}

function isAdminRoute(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function isMediaApi(pathname: string): boolean {
  return pathname === "/api/media" || pathname.startsWith("/api/media/");
}

/**
 * Whether this request needs a session.
 *
 * `/admin/*` is gated for every method; the JSON APIs are gated for mutations
 * only. Media upload is gated outright — there is no read side to it.
 */
export function isProtected(pathname: string, method: string): boolean {
  if (isPublic(pathname, method)) return false;
  return isAdminRoute(pathname) || isPostsApi(pathname) || isMediaApi(pathname);
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
