import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SESSION_TTL_SECONDS,
  createSessionToken,
  secretsMatch,
  verifySessionToken,
} from "@/lib/session";

const SECRET = "a-test-secret-that-is-long-enough-0123456789";

describe("session tokens", () => {
  it("round-trips a signed session", async () => {
    const token = await createSessionToken(SECRET);
    const session = await verifySessionToken(token, SECRET);

    assert.equal(session?.subject, "admin");
    assert.ok(session !== null);
    const ttl = (session.expiresAt - Date.now()) / 1000;
    assert.ok(ttl > SESSION_TTL_SECONDS - 60 && ttl <= SESSION_TTL_SECONDS);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(SECRET);
    assert.equal(await verifySessionToken(token, "some-other-secret"), null);
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken(SECRET);
    const [, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, sub: "admin", exp: 9999999999 }),
    ).toString("base64url");

    assert.equal(await verifySessionToken(`${forged}.${signature}`, SECRET), null);
  });

  it("rejects a tampered signature", async () => {
    const token = await createSessionToken(SECRET);
    const [body] = token.split(".");
    assert.equal(await verifySessionToken(`${body}.AAAA`, SECRET), null);
  });

  it("rejects an expired token", async () => {
    const token = await createSessionToken(SECRET, { ttlSeconds: -10 });
    assert.equal(await verifySessionToken(token, SECRET), null);
  });

  it("treats malformed and missing cookies as no session", async () => {
    for (const value of [undefined, "", "nonsense", "a.b.c", "."]) {
      assert.equal(await verifySessionToken(value, SECRET), null, `for ${value}`);
    }
  });

  it("compares secrets without short-circuiting on length", async () => {
    assert.equal(await secretsMatch("hunter2", "hunter2"), true);
    assert.equal(await secretsMatch("hunter2", "hunter3"), false);
    assert.equal(await secretsMatch("hunter2", "hunter2-longer"), false);
    assert.equal(await secretsMatch("", ""), true);
  });
});
