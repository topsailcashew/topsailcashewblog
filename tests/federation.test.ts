import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { buildActor, buildWebFinger, handle } from "@/lib/activitypub/actor";
import { buildCreate, buildNote, noteId } from "@/lib/activitypub/activities";
import { postIdFromNoteUri, sameActor } from "@/lib/activitypub/inbox";
import { fromPem, toPem, type FediverseSettings } from "@/lib/activitypub/keys";
import {
  buildSigningString,
  parseSignatureHeader,
  signRequest,
  verifySignedRequest,
} from "@/lib/activitypub/signatures";

/*
  Every URL in ActivityPub is absolute and must resolve. With no origin
  configured the actor's id would be "/ap/actor", which no remote server can
  fetch — so the tests run with one set, exactly as production does.
*/
const ORIGIN = "https://blog.example";

let keyPair: { publicKeyPem: string; privateKeyPem: string };

before(async () => {
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;

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
  keyPair = {
    publicKeyPem: toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
    privateKeyPem: toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  };
});

const settings: FediverseSettings = {
  enabled: true,
  username: "topsailcashew",
  summary: "Essays and notes.",
  privateKeyCipher: null,
  publicKeyPem: "PEM",
};

describe("PEM encoding", () => {
  it("round-trips DER through the armour", () => {
    const der = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    const pem = toPem("PUBLIC KEY", der.buffer as ArrayBuffer);
    assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n/);
    assert.deepEqual(Array.from(fromPem(pem)), Array.from(der));
  });

  it("wraps at 64 characters, as the format requires", () => {
    const der = new Uint8Array(200).fill(7);
    const body = toPem("PRIVATE KEY", der.buffer as ArrayBuffer)
      .split("\n")
      .slice(1, -2);
    assert.ok(body.every((line) => line.length <= 64));
  });

  it("accepts a key that arrived with different whitespace", () => {
    // Keys come back from other servers re-indented, with carriage returns,
    // or with the trailing newline stripped by whatever JSON tooling they
    // passed through. All three are the same key.
    const der = new Uint8Array([9, 8, 7, 6]);
    const pem = toPem("PUBLIC KEY", der.buffer as ArrayBuffer);
    const mangled = pem.replace(/\n/g, "\r\n  ").trim();
    assert.deepEqual(Array.from(fromPem(mangled)), Array.from(der));
  });
});

describe("actor document", () => {
  it("gives every endpoint an absolute URL", () => {
    const actor = buildActor(settings);
    for (const value of [actor.id, actor.inbox, actor.outbox, actor.followers]) {
      assert.match(String(value), new RegExp(`^${ORIGIN}/`), String(value));
    }
    assert.equal(actor.type, "Person");
    assert.equal(actor.publicKey.owner, actor.id);
    assert.equal(actor.publicKey.id, `${actor.id}#main-key`);
  });

  it("resolves the handle a person would type", () => {
    assert.equal(handle(settings), "topsailcashew@blog.example");
    const finger = buildWebFinger(settings);
    assert.equal(finger.subject, "acct:topsailcashew@blog.example");

    const self = finger.links.find((link) => link.rel === "self");
    assert.equal(self?.type, "application/activity+json");
    assert.equal(self?.href, `${ORIGIN}/ap/actor`);
  });
});

describe("activities", () => {
  const post = {
    id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    title: "On slow software",
    slug: "on-slow-software",
    excerpt: "A note about waiting.",
    published_at: "2026-08-01T09:00:00.000Z",
    cover_image_url: "/media/2026/08/cover.jpg",
    tags: [{ name: "Slow Software", slug: "slow-software" }],
  };

  it("addresses the public collection so it reaches timelines", () => {
    const create = buildCreate(post);
    assert.ok(create.to.includes("https://www.w3.org/ns/activitystreams#Public"));
    assert.ok(create.cc.includes(`${ORIGIN}/ap/followers`));
    assert.equal(create.type, "Create");
    assert.equal(create.object.type, "Note");
  });

  it("derives ids from the post, so a redelivery is the same object", () => {
    assert.equal(buildCreate(post).object.id, noteId(post.id));
    assert.equal(buildCreate(post).id, `${noteId(post.id)}/create`);
  });

  it("escapes a title that would otherwise inject markup", () => {
    const note = buildNote({ ...post, title: '<script>alert(1)</script>', excerpt: null });
    assert.ok(!note.content.includes("<script>"));
    assert.ok(note.content.includes("&lt;script&gt;"));
  });

  it("makes a relative cover URL absolute", () => {
    const [attachment] = buildNote(post).attachment;
    assert.equal(attachment.url, `${ORIGIN}/media/2026/08/cover.jpg`);
  });

  it("turns tags into hashtags without the hyphens", () => {
    // "#slow-software" is not a hashtag anywhere in the fediverse; it renders
    // as "#slow" followed by literal text.
    assert.equal(buildNote(post).tag[0].name, "#slowsoftware");
  });
});

describe("HTTP signatures", () => {
  const inbox = "https://remote.example/users/alice/inbox";
  const body = JSON.stringify({ type: "Create" });

  async function sign(overrides: { body?: string; url?: string } = {}) {
    return signRequest({
      method: "POST",
      url: overrides.url ?? inbox,
      body: overrides.body ?? body,
      privateKeyPem: keyPair.privateKeyPem,
      keyId: `${ORIGIN}/ap/actor#main-key`,
    });
  }

  function asRequest(headers: Record<string, string>, requestBody: string, url = inbox) {
    return {
      method: "POST",
      url,
      headers: new Headers(headers),
      body: requestBody,
    };
  }

  const resolve = async () => keyPair.publicKeyPem;

  it("signs and verifies a round trip", async () => {
    const headers = await sign();
    const result = await verifySignedRequest(asRequest(headers, body), resolve);
    assert.deepEqual(result, { ok: true, keyId: `${ORIGIN}/ap/actor#main-key` });
  });

  it("covers the body, so a swapped payload is rejected", async () => {
    const headers = await sign();
    const result = await verifySignedRequest(
      asRequest(headers, JSON.stringify({ type: "Delete" })),
      resolve,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /digest/i);
  });

  it("covers the request target, so a signature cannot be replayed elsewhere", async () => {
    // Signed for one inbox, presented at another. Without (request-target) in
    // the signing string this would verify.
    const headers = await sign();
    const result = await verifySignedRequest(
      asRequest(headers, body, "https://remote.example/users/bob/inbox"),
      resolve,
    );
    assert.equal(result.ok, false);
  });

  it("rejects a signature made with a different key", async () => {
    const other = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const otherPublic = toPem(
      "PUBLIC KEY",
      await crypto.subtle.exportKey("spki", other.publicKey),
    );

    const headers = await sign();
    const result = await verifySignedRequest(
      asRequest(headers, body),
      async () => otherPublic,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /Bad signature/);
  });

  it("refuses a stale request", async () => {
    const headers = await sign();
    const result = await verifySignedRequest(
      asRequest({ ...headers, date: new Date(Date.now() - 3_600_000).toUTCString() }, body),
      resolve,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /window/);
  });

  it("refuses a signature that does not cover the date", async () => {
    // Replayable forever otherwise: capture one valid request, resend it daily.
    const headers = await sign();
    const stripped = headers.signature.replace(
      /headers="[^"]*"/,
      'headers="(request-target) host digest"',
    );
    const result = await verifySignedRequest(
      asRequest({ ...headers, signature: stripped }, body),
      resolve,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /date/i);
  });

  it("refuses a POST whose signature omits the digest", async () => {
    const headers = await sign();
    const stripped = headers.signature.replace(
      /headers="[^"]*"/,
      'headers="(request-target) host date"',
    );
    const result = await verifySignedRequest(
      asRequest({ ...headers, signature: stripped }, body),
      resolve,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /digest/i);
  });

  it("refuses when the key cannot be fetched", async () => {
    const headers = await sign();
    const result = await verifySignedRequest(asRequest(headers, body), async () => null);
    assert.equal(result.ok, false);
  });

  it("parses a header whose values contain commas and URLs", () => {
    const parsed = parseSignatureHeader(
      'keyId="https://a.example/users/x#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="AAAA=="',
    );
    assert.equal(parsed?.keyId, "https://a.example/users/x#main-key");
    assert.deepEqual(parsed?.headers, ["(request-target)", "host", "date", "digest"]);
    assert.equal(parsed?.signature, "AAAA==");
  });

  it("defaults to signing the date alone when no header list is given", () => {
    // The draft's default. Getting this wrong makes every minimally-signed
    // request from an older implementation fail to verify.
    assert.deepEqual(parseSignatureHeader('keyId="k",signature="s"')?.headers, ["date"]);
  });

  it("lowercases header names in the signing string", () => {
    const string = buildSigningString(["(request-target)", "Host"], {
      "(request-target)": "post /inbox",
      host: "example.com",
    });
    assert.equal(string, "(request-target): post /inbox\nhost: example.com");
  });
});

describe("inbox guards", () => {
  it("accepts a key id that is the actor URL plus a fragment", () => {
    assert.equal(
      sameActor("https://a.example/users/bob#main-key", "https://a.example/users/bob"),
      true,
    );
    assert.equal(
      sameActor("https://a.example/users/bob/", "https://a.example/users/bob"),
      true,
    );
  });

  it("rejects a key belonging to somebody else", () => {
    // Without this, anyone with a valid fediverse account could sign an
    // activity attributed to a different actor and have it accepted.
    assert.equal(
      sameActor("https://a.example/users/mallory#main-key", "https://a.example/users/bob"),
      false,
    );
    assert.equal(
      sameActor("https://evil.example/users/bob#main-key", "https://a.example/users/bob"),
      false,
    );
  });

  it("reads a post id out of one of our own note URIs, and nothing else", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    assert.equal(postIdFromNoteUri(`${ORIGIN}/ap/notes/${id}`), id);
    assert.equal(postIdFromNoteUri(`${ORIGIN}/ap/notes/${id}#fragment`), id);
    assert.equal(postIdFromNoteUri(`https://evil.example/ap/notes/${id}`), null);
    assert.equal(postIdFromNoteUri(`${ORIGIN}/ap/notes/not-a-uuid`), null);
    assert.equal(postIdFromNoteUri("https://mastodon.social/@someone/123"), null);
  });
});
