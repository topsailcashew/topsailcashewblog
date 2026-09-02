import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DRIVE_SCOPE,
  GoogleAuthError,
  getAccessToken,
  resetTokenCache,
  serviceAccountFromEnv,
} from "@/lib/google-auth";

/** A real RSA key pair, so the signature can actually be verified. */
async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")));
}

function bytesOf(segment: string): Uint8Array<ArrayBuffer> {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Captures the assertion instead of calling Google. */
function stubTokenEndpoint(response: { status?: number; body?: unknown } = {}) {
  const captured: { assertion?: string; grantType?: string } = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const params = new URLSearchParams(init?.body as string);
    captured.assertion = params.get("assertion") ?? undefined;
    captured.grantType = params.get("grant_type") ?? undefined;
    const status = response.status ?? 200;
    return new Response(
      JSON.stringify(response.body ?? { access_token: "token-abc", expires_in: 3600 }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { captured, restore: () => { globalThis.fetch = original; } };
}

describe("google service account auth", () => {
  afterEach(resetTokenCache);

  describe("credentials from the environment", () => {
    it("is absent when nothing is configured", () => {
      assert.equal(serviceAccountFromEnv({}), null);
      assert.equal(serviceAccountFromEnv({ GOOGLE_CLIENT_EMAIL: "a@b.com" }), null);
    });

    it("unescapes a key pasted straight out of the JSON key file", () => {
      // The JSON field carries literal backslash-n, not real newlines.
      const account = serviceAccountFromEnv({
        GOOGLE_CLIENT_EMAIL: "importer@project.iam.gserviceaccount.com",
        GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n",
      });
      assert.ok(account);
      assert.ok(account.privateKey.includes("\n"));
      assert.ok(!account.privateKey.includes("\\n"));
    });

    it("strips quotes a shell may have left around the key", () => {
      const account = serviceAccountFromEnv({
        GOOGLE_CLIENT_EMAIL: "a@b.com",
        GOOGLE_PRIVATE_KEY: '"-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----"',
      });
      assert.ok(account!.privateKey.startsWith("-----BEGIN"));
      assert.ok(account!.privateKey.endsWith("-----"));
    });
  });

  describe("the signed assertion", () => {
    it("carries the claims Google expects, and verifies against the key", async () => {
      const { pem, publicKey } = await makeKeyPair();
      const stub = stubTokenEndpoint();

      try {
        const token = await getAccessToken({
          clientEmail: "importer@project.iam.gserviceaccount.com",
          privateKey: pem,
        });
        assert.equal(token, "token-abc");
        assert.equal(stub.captured.grantType, "urn:ietf:params:oauth:grant-type:jwt-bearer");

        const [header, claims, signature] = stub.captured.assertion!.split(".");
        assert.deepEqual(decodeSegment(header), { alg: "RS256", typ: "JWT" });

        const payload = decodeSegment(claims);
        assert.equal(payload.iss, "importer@project.iam.gserviceaccount.com");
        assert.equal(payload.scope, DRIVE_SCOPE);
        assert.equal(payload.aud, "https://oauth2.googleapis.com/token");
        assert.ok((payload.exp as number) > (payload.iat as number));

        // The signature is real: it verifies against the matching public key.
        const valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          publicKey,
          bytesOf(signature),
          new TextEncoder().encode(`${header}.${claims}`),
        );
        assert.equal(valid, true, "assertion signature should verify");
      } finally {
        stub.restore();
      }
    });

    it("asks only for read access", async () => {
      assert.equal(DRIVE_SCOPE, "https://www.googleapis.com/auth/drive.readonly");
    });

    it("reuses a token rather than minting one per request", async () => {
      const { pem } = await makeKeyPair();
      let calls = 0;
      const original = globalThis.fetch;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      try {
        const account = { clientEmail: "a@b.com", privateKey: pem };
        await getAccessToken(account);
        await getAccessToken(account);
        await getAccessToken(account);
        assert.equal(calls, 1, "an import makes many Drive calls on one token");
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe("failures", () => {
    it("rejects a key that is not a PEM", async () => {
      await assert.rejects(
        () => getAccessToken({ clientEmail: "a@b.com", privateKey: "not-a-key" }),
        GoogleAuthError,
      );
    });

    it("explains an invalid_grant rather than passing it through raw", async () => {
      const { pem } = await makeKeyPair();
      const stub = stubTokenEndpoint({
        status: 400,
        body: { error: "invalid_grant", error_description: "Invalid JWT" },
      });
      try {
        await assert.rejects(
          () => getAccessToken({ clientEmail: "a@b.com", privateKey: pem }),
          /clock|revoked/i,
        );
      } finally {
        stub.restore();
      }
    });

    it("names the likely cause of an unauthorized_client", async () => {
      const { pem } = await makeKeyPair();
      const stub = stubTokenEndpoint({
        status: 401,
        body: { error: "unauthorized_client" },
      });
      try {
        await assert.rejects(
          () => getAccessToken({ clientEmail: "a@b.com", privateKey: pem }),
          /GOOGLE_CLIENT_EMAIL/,
        );
      } finally {
        stub.restore();
      }
    });
  });
});
