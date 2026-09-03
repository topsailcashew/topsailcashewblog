import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { PROTECTED_API_PREFIXES, authorize, isProtected } from "@/lib/auth";
import { safeRedirectPath } from "@/lib/redirect";
import { SESSION_COOKIE, createSessionToken } from "@/lib/session";

const SECRET = "auth-test-secret-long-enough-0123456789";

describe("route protection", () => {
  it("gates the admin area and every mutating API route", () => {
    const gated: [string, string][] = [
      ["/admin", "GET"],
      ["/admin/posts/new", "GET"],
      ["/admin/posts/abc", "POST"],
      ["/api/posts", "GET"],
      ["/api/posts", "POST"],
      ["/api/posts/abc", "GET"],
      ["/api/posts/abc", "PATCH"],
      ["/api/posts/abc", "DELETE"],
      ["/api/posts/abc/revisions", "GET"],
      ["/api/posts/abc/preview", "POST"],
      ["/api/pages", "GET"],
      ["/api/pages", "POST"],
      ["/api/pages/abc", "PATCH"],
      ["/api/media", "POST"],
      ["/api/media", "GET"],
      // Comment moderation and series management are admin-only.
      ["/api/comments", "GET"],
      ["/api/comments", "PATCH"],
      ["/api/comments/abc", "POST"],
      ["/api/comments/abc", "PATCH"],
      ["/api/series", "GET"],
      ["/api/series", "POST"],
      ["/api/series/abc", "DELETE"],
      ["/admin/comments", "GET"],
      ["/admin/series", "GET"],
    ];
    for (const [pathname, method] of gated) {
      assert.equal(isProtected(pathname, method), true, `${method} ${pathname}`);
    }
  });

  it("opens comment submission but nothing else under that path", () => {
    // A near-miss on either the path or the method must still be gated.
    assert.equal(isProtected("/api/comments", "POST"), false);
    assert.equal(isProtected("/api/comments", "GET"), true);
    assert.equal(isProtected("/api/comments", "DELETE"), true);
    assert.equal(isProtected("/api/comments/", "POST"), true);
    assert.equal(isProtected("/api/comments/abc", "POST"), true);
  });

  it("leaves media files and the login flow open", () => {
    const open: [string, string][] = [
      ["/admin/login", "GET"],
      ["/api/auth/login", "POST"],
      ["/api/auth/logout", "POST"],
      ["/media/2026/08/x.png", "GET"],
      ["/", "GET"],
      // The one public write: submitting a comment. It lands as pending.
      ["/api/comments", "POST"],
      // A preview link is a capability of its own; the route reads the token,
      // not a session.
      ["/preview/some-token", "GET"],
    ];
    for (const [pathname, method] of open) {
      assert.equal(isProtected(pathname, method), false, `${method} ${pathname}`);
    }
  });

  it("does not let a lookalike prefix slip past the gate", () => {
    // `/api/posts-secret` must not be treated as inside /api/posts.
    assert.equal(isProtected("/api/postsfoo", "POST"), false);
    assert.equal(isProtected("/adminfoo", "GET"), false);
    assert.equal(isProtected("/api/commentsfoo", "GET"), false);
    assert.equal(isProtected("/api/seriesfoo", "GET"), false);
  });
});

describe("authorize", () => {
  const request = (cookie?: string) =>
    new NextRequest("http://localhost/api/posts", {
      method: "POST",
      headers: cookie ? { cookie } : {},
    });

  it("accepts a valid session cookie", async () => {
    process.env.SESSION_SECRET = SECRET;
    const token = await createSessionToken(SECRET);
    const result = await authorize(request(`${SESSION_COOKIE}=${token}`));
    assert.deepEqual(result, { ok: true, subject: "admin" });
  });

  it("rejects a missing cookie with 401", async () => {
    process.env.SESSION_SECRET = SECRET;
    const result = await authorize(request());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 401);
  });

  it("fails closed with 500 when SESSION_SECRET is unset", async () => {
    const previous = process.env.SESSION_SECRET;
    // The generated CloudflareEnv types now declare SESSION_SECRET as a
    // required string (wrangler reads the deployed Worker's secret names), so
    // the delete needs a looser view of process.env. Assigning `undefined`
    // would not do — Node coerces that to the string "undefined".
    delete (process.env as Record<string, string | undefined>).SESSION_SECRET;
    try {
      const token = await createSessionToken(SECRET);
      const result = await authorize(request(`${SESSION_COOKIE}=${token}`));
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.status, 500);
    } finally {
      process.env.SESSION_SECRET = previous;
    }
  });
});

describe("safeRedirectPath", () => {
  it("keeps same-site paths and rejects anything that leaves the site", () => {
    assert.equal(safeRedirectPath("/admin/posts/abc"), "/admin/posts/abc");
    assert.equal(safeRedirectPath("//evil.example"), "/admin");
    assert.equal(safeRedirectPath("https://evil.example"), "/admin");
    assert.equal(safeRedirectPath("/admin/login"), "/admin");
    assert.equal(safeRedirectPath(null), "/admin");
    assert.equal(safeRedirectPath(""), "/admin");
  });
});

describe("the proxy matcher and the protected list agree", () => {
  it("routes every protected prefix through the proxy", async () => {
    // A prefix gated in auth.ts but absent from proxy.ts's matcher does not
    // fail: the proxy simply never runs for it, and the route is open with
    // nothing to notice. This is the check that would have caught it.
    const { config } = await import("@/proxy");
    const matched = new Set(
      config.matcher.map((pattern) => pattern.replace(/\/:path\*$/, "")),
    );

    for (const prefix of PROTECTED_API_PREFIXES) {
      assert.ok(
        matched.has(prefix),
        `${prefix} is gated in auth.ts but missing from the proxy matcher`,
      );
    }
    assert.ok(matched.has("/admin"));
  });

  it("gates the audience, settings and newsletter endpoints", () => {
    const gated: [string, string][] = [
      ["/api/subscribers", "GET"],
      ["/api/subscribers/abc", "GET"],
      ["/api/subscribers/abc", "DELETE"],
      ["/api/settings", "GET"],
      ["/api/settings", "PUT"],
      ["/api/settings/test", "POST"],
      ["/api/newsletter", "GET"],
      ["/api/posts/abc/newsletter", "POST"],
      /*
        The AI routes need no change to PROTECTED_API_PREFIXES or the proxy
        matcher, because they nest under prefixes already gated for every
        method. These assertions are what proves that, rather than assuming it.
      */
      ["/api/posts/abc/analysis", "POST"],
      ["/api/posts/abc/suggest", "POST"],
      ["/api/posts/abc/cover", "POST"],
      ["/api/settings/ai/test", "POST"],
      ["/admin/subscribers", "GET"],
      ["/admin/settings", "GET"],
    ];
    for (const [pathname, method] of gated) {
      assert.equal(isProtected(pathname, method), true, `${method} ${pathname}`);
    }
  });

  it("opens the signup endpoint without opening the subscriber list", () => {
    /*
      "/api/subscribers".startsWith("/api/subscribe") is true. If the public
      exemption were a prefix match rather than an exact one, opening the
      signup form would also have published the entire audience — every
      address, every UTM tag — to anyone who asked.
    */
    assert.equal(isProtected("/api/subscribe", "POST"), false);
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      assert.equal(
        isProtected("/api/subscribers", method),
        true,
        `${method} /api/subscribers`,
      );
      assert.equal(isProtected("/api/subscribers/abc", method), true);
    }
  });

  it("leaves the reader-facing email endpoints open", () => {
    // Each carries its own signed token; none is under a protected prefix.
    const open: [string, string][] = [
      ["/e/o/token", "GET"],
      ["/e/c/token", "GET"],
      ["/e/u", "GET"],
      ["/e/u", "POST"],
      ["/newsletter/confirm", "GET"],
      ["/newsletter/unsubscribe", "GET"],
    ];
    for (const [pathname, method] of open) {
      assert.equal(isProtected(pathname, method), false, `${method} ${pathname}`);
    }
  });
});
