/**
 * Pure, dependency-free — safe to import from both the proxy and client
 * components. Keeping it out of `auth.ts` stops the login form from pulling
 * server-only code (env access, session verification) into the client bundle.
 */

/**
 * Guards the `?next=` parameter on the login form. Only same-site absolute
 * paths are allowed, so a crafted link cannot bounce someone off-site after
 * they authenticate.
 */
export function safeRedirectPath(value: string | null | undefined): string {
  if (!value) return "/admin";
  if (!value.startsWith("/") || value.startsWith("//")) return "/admin";
  if (value.startsWith("/admin/login")) return "/admin";
  return value;
}
