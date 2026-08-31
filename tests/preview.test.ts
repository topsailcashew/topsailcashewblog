import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProtected } from "@/lib/auth";
import { createPreviewToken, verifyPreviewToken } from "@/lib/preview";
import { createSessionToken, verifySessionToken } from "@/lib/session";

const SECRET = "preview-test-secret-long-enough-0123456789";
const OTHER = "a-completely-different-secret-0123456789";
const POST_ID = "0f3b9f5e-2a4e-4c0e-9a1e-6f1b2c3d4e5f";

describe("draft preview links", () => {
  it("round-trips the post it authorises", async () => {
    const token = await createPreviewToken(POST_ID, SECRET);
    assert.equal(await verifyPreviewToken(token, SECRET), POST_ID);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createPreviewToken(POST_ID, OTHER);
    assert.equal(await verifyPreviewToken(token, SECRET), null);
  });

  it("rejects a token whose payload has been edited", async () => {
    const token = await createPreviewToken(POST_ID, SECRET);
    const [body, signature] = token.split(".");

    // Re-encode the payload pointing at a different post, keeping the
    // signature — the whole point of signing it.
    const decoded = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { id: string };
    decoded.id = "11111111-2222-3333-4444-555555555555";
    const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url");

    assert.equal(await verifyPreviewToken(`${forged}.${signature}`, SECRET), null);
  });

  it("rejects an expired token", async () => {
    const token = await createPreviewToken(POST_ID, SECRET, -1);
    assert.equal(await verifyPreviewToken(token, SECRET), null);
  });

  it("treats a malformed or missing token as no access", async () => {
    for (const value of [undefined, "", "no-separator", ".", "a.b", "....."]) {
      assert.equal(await verifyPreviewToken(value, SECRET), null);
    }
  });

  it("cannot be replayed as a session cookie, or the reverse", async () => {
    // Both are HMAC-SHA256 over the same secret; the signed message is domain
    // separated so neither verifier accepts the other's token.
    const preview = await createPreviewToken(POST_ID, SECRET);
    assert.equal(await verifySessionToken(preview, SECRET), null);

    const session = await createSessionToken(SECRET);
    assert.equal(await verifyPreviewToken(session, SECRET), null);
  });

  it("grants no admin access — the route is not behind the session gate", () => {
    // /preview/* is public by design: the token is the credential. What must
    // stay true is that holding one opens nothing else.
    assert.equal(isProtected("/preview/some-token", "GET"), false);
    assert.equal(isProtected("/admin", "GET"), true);
    assert.equal(isProtected("/api/posts/abc", "PATCH"), true);
  });
});
