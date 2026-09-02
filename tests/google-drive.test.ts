import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { importFromDrive } from "@/lib/drive-import";
import { resetTokenCache } from "@/lib/google-auth";
import {
  createDriveClient,
  DriveError,
  MAX_DEPTH,
  MAX_FILES,
} from "@/lib/google-drive";
import { getPostById } from "@/lib/posts";
import { db, hasDatabase, resetTables, setupDatabase, teardownDatabase } from "./helpers";

/**
 * A stand-in for Google, speaking the shapes the Drive v3 REST API actually
 * returns. This is the same trick the Neon shim uses elsewhere in this
 * project: run the real client, with the real fetch calls and the real
 * parsing, against something local that answers the way the service does.
 *
 * It covers everything except the network hop to Google itself.
 */

type FakeEntry = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  parent: string;
  body?: string;
};

const DOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";

function fakeGoogle(entries: FakeEntry[], options: { pageSize?: number } = {}) {
  const calls: string[] = [];
  const exported: string[] = [];
  const downloaded: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url.pathname + url.search);

    if (url.host === "oauth2.googleapis.com") {
      // The real call sends URLSearchParams, not a string.
      assert.match(String(init?.body), /assertion=/, "expected a signed assertion");
      return json({ access_token: "fake-token", expires_in: 3600 });
    }

    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      "Bearer fake-token",
      "every Drive call must carry the token",
    );

    // .../files/{id}/export
    const exportMatch = /\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
    if (exportMatch) {
      const entry = entries.find((e) => e.id === exportMatch[1]);
      assert.equal(url.searchParams.get("mimeType"), "text/markdown");
      exported.push(exportMatch[1]);
      return text(entry?.body ?? "");
    }

    // .../files/{id}?alt=media
    const getMatch = /\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (getMatch && url.searchParams.get("alt") === "media") {
      const entry = entries.find((e) => e.id === getMatch[1]);
      downloaded.push(getMatch[1]);
      return text(entry?.body ?? "");
    }

    // .../files?q=...
    const query = url.searchParams.get("q") ?? "";
    const parent = /^'(.+?)' in parents/.exec(query)?.[1]?.replace(/\\'/g, "'");
    assert.match(query, /trashed = false/, "the listing must exclude trashed files");

    const children = entries.filter((e) => e.parent === parent);
    const size = options.pageSize ?? 100;
    const offset = Number(url.searchParams.get("pageToken") ?? "0");
    const page = children.slice(offset, offset + size);
    const next = offset + size < children.length ? String(offset + size) : undefined;

    return json({
      files: page.map((e) => ({
        id: e.id,
        name: e.name,
        mimeType: e.mimeType,
        modifiedTime: e.modifiedTime ?? "2026-09-01T10:00:00.000Z",
      })),
      ...(next ? { nextPageToken: next } : {}),
    });
  }) as typeof fetch;

  return { calls, exported, downloaded, restore: () => { globalThis.fetch = original; } };
}

function failWith(status: number, body = "") {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.host === "oauth2.googleapis.com") {
      return json({ access_token: "fake-token", expires_in: 3600 });
    }
    return new Response(body, { status });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const text = (value: string) =>
  new Response(value, { status: 200, headers: { "content-type": "text/plain" } });

/** A syntactically valid PKCS#8 key, generated once for the whole file. */
let account: { clientEmail: string; privateKey: string };

before(async () => {
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
  account = {
    clientEmail: "importer@test.iam.gserviceaccount.com",
    privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`,
  };
});

describe("drive client", () => {
  afterEach(resetTokenCache);

  it("walks subfolders and records the path to each document", async () => {
    const fake = fakeGoogle([
      { id: "f1", name: "Drafts", mimeType: FOLDER, parent: "root" },
      { id: "d1", name: "Top.md", mimeType: "text/markdown", parent: "root" },
      { id: "f2", name: "2026", mimeType: FOLDER, parent: "f1" },
      { id: "d2", name: "Nested.md", mimeType: "text/markdown", parent: "f1" },
      { id: "d3", name: "Deeper.md", mimeType: "text/markdown", parent: "f2" },
    ]);
    try {
      const listing = await createDriveClient(account).listFolder("root");
      assert.deepEqual(
        listing.files.map((f) => [f.name, f.path.join("/")]).sort(),
        [
          ["Deeper.md", "Drafts/2026"],
          ["Nested.md", "Drafts"],
          ["Top.md", ""],
        ],
      );
    } finally {
      fake.restore();
    }
  });

  it("follows pagination rather than stopping at the first page", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `d${i}`,
      name: `Doc ${i}.md`,
      mimeType: "text/markdown",
      parent: "root",
    }));
    const fake = fakeGoogle(many, { pageSize: 10 });
    try {
      const listing = await createDriveClient(account).listFolder("root");
      assert.equal(listing.files.length, 25);
      // Three pages: two full and a partial.
      assert.equal(fake.calls.filter((c) => c.includes("/drive/v3/files?")).length, 3);
    } finally {
      fake.restore();
    }
  });

  it("names what it passed over, and why", async () => {
    const fake = fakeGoogle([
      { id: "a", name: "Notes.md", mimeType: "text/markdown", parent: "root" },
      { id: "b", name: "photo.jpg", mimeType: "image/jpeg", parent: "root" },
      { id: "c", name: "budget", mimeType: "application/vnd.google-apps.spreadsheet", parent: "root" },
      { id: "d", name: "scan.pdf", mimeType: "application/pdf", parent: "root" },
      { id: "e", name: "old.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parent: "root" },
    ]);
    try {
      const listing = await createDriveClient(account).listFolder("root");
      assert.deepEqual(listing.files.map((f) => f.name), ["Notes.md"]);
      assert.deepEqual(
        Object.fromEntries(listing.skipped.map((s) => [s.name, s.reason])),
        {
          "photo.jpg": "an image, not a document",
          budget: "a spreadsheet",
          "scan.pdf": "a PDF",
          "old.docx": "a .docx — open it in Google Docs first",
        },
      );
    } finally {
      fake.restore();
    }
  });

  it("stops descending past the depth cap and says so", async () => {
    const entries: FakeEntry[] = [];
    let parent = "root";
    for (let depth = 1; depth <= MAX_DEPTH + 2; depth += 1) {
      entries.push({ id: `f${depth}`, name: `Level ${depth}`, mimeType: FOLDER, parent });
      entries.push({
        id: `doc${depth}`,
        name: `Doc ${depth}.md`,
        mimeType: "text/markdown",
        parent: `f${depth}`,
      });
      parent = `f${depth}`;
    }

    const fake = fakeGoogle(entries);
    try {
      const listing = await createDriveClient(account).listFolder("root");
      assert.equal(listing.files.length, MAX_DEPTH);
      assert.ok(
        listing.skipped.some((s) => s.reason.includes(`deeper than ${MAX_DEPTH}`)),
        "the folder it refused to open should be reported",
      );
    } finally {
      fake.restore();
    }
  });

  it("reports truncation instead of silently taking the first hundred", async () => {
    const many = Array.from({ length: MAX_FILES + 12 }, (_, i) => ({
      id: `d${i}`,
      name: `Doc ${i}.md`,
      mimeType: "text/markdown",
      parent: "root",
    }));
    const fake = fakeGoogle(many);
    try {
      const listing = await createDriveClient(account).listFolder("root");
      assert.equal(listing.files.length, MAX_FILES);
      assert.equal(listing.truncated, true);
    } finally {
      fake.restore();
    }
  });

  it("exports a Google Doc but downloads a plain file", async () => {
    const fake = fakeGoogle([
      { id: "gdoc", name: "A Doc", mimeType: DOC, parent: "root", body: "# From Docs" },
      { id: "plain", name: "notes.md", mimeType: "text/markdown", parent: "root", body: "# From a file" },
    ]);
    try {
      const client = createDriveClient(account);
      const listing = await client.listFolder("root");
      const doc = listing.files.find((f) => f.id === "gdoc")!;
      const plain = listing.files.find((f) => f.id === "plain")!;

      assert.equal(await client.readFile(doc), "# From Docs");
      assert.equal(await client.readFile(plain), "# From a file");
      // A Google Doc has no bytes to download; it must go through export.
      assert.deepEqual(fake.exported, ["gdoc"]);
      assert.deepEqual(fake.downloaded, ["plain"]);
    } finally {
      fake.restore();
    }
  });

  it("escapes a folder id so it cannot break out of the query", async () => {
    const fake = fakeGoogle([]);
    try {
      await createDriveClient(account).listFolder("we're-odd");
      const listing = fake.calls.find((c) => c.includes("/drive/v3/files?"))!;
      const q = new URLSearchParams(listing.split("?")[1]).get("q");
      assert.equal(q, "'we\\'re-odd' in parents and trashed = false");
    } finally {
      fake.restore();
    }
  });

  describe("failures say what to do", () => {
    it("explains a 404 as a folder id or sharing problem", async () => {
      const fake = failWith(404);
      try {
        await assert.rejects(
          () => createDriveClient(account).listFolder("nope"),
          (error: DriveError) => {
            // [\s\S] rather than the `s` flag, which needs a newer tsconfig target.
            assert.match(error.message, /folder id[\s\S]*shared with the service account/);
            assert.equal(error.status, 404);
            return true;
          },
        );
      } finally {
        fake.restore();
      }
    });

    it("explains a 403 as a sharing or API-enablement problem", async () => {
      const fake = failWith(403);
      try {
        await assert.rejects(
          () => createDriveClient(account).listFolder("x"),
          /share it with the service account|enable the Drive API/,
        );
      } finally {
        fake.restore();
      }
    });

    it("passes through anything else with its status", async () => {
      const fake = failWith(500, "backend error");
      try {
        await assert.rejects(
          () => createDriveClient(account).listFolder("x"),
          /Drive request failed \(500\)/,
        );
      } finally {
        fake.restore();
      }
    });
  });
});

describe(
  "the whole import, end to end",
  { skip: hasDatabase ? false : "TEST_DATABASE_URL not set" },
  () => {
    before(setupDatabase);
    after(teardownDatabase);
    beforeEach(async () => {
      await resetTables();
      resetTokenCache();
    });

    it("turns a folder of Google Docs into drafts on the site", async () => {
      const fake = fakeGoogle([
        { id: "fA", name: "Essays", mimeType: FOLDER, parent: "root" },
        {
          id: "doc-1",
          name: "On Slow Software",
          mimeType: DOC,
          parent: "root",
          body: [
            "# On Slow Software",
            "",
            "There is a particular kind of **impatience** in this work.",
            "",
            "## What it costs",
            "",
            "*   Rework, deferred",
            "*   Confidence, borrowed",
            "    *   And repaid with interest",
            "",
            "See [the earlier note](https://example.com/earlier_(part-two)) for context.",
            "",
            "![][image1]",
            "",
            "[image1]: https://example.com/diagram.png",
          ].join("\n"),
        },
        {
          id: "doc-2",
          name: "A Nested Draft",
          mimeType: DOC,
          parent: "fA",
          body: "# A Nested Draft\n\nShort body.",
        },
        { id: "img", name: "cover.jpg", mimeType: "image/jpeg", parent: "root" },
      ]);

      try {
        const report = await importFromDrive(
          db(),
          createDriveClient(account),
          "root",
        );

        assert.equal(report.counts.created, 2);
        assert.equal(report.counts.failed, 0);
        assert.deepEqual(report.skipped, [
          { name: "cover.jpg", reason: "an image, not a document" },
        ]);

        const first = report.items.find((i) => i.file === "On Slow Software")!;
        assert.equal(first.folder, "(top level)");
        const post = await getPostById(db(), first.postId!);

        assert.equal(post?.title, "On Slow Software");
        assert.equal(post?.status, "draft");
        assert.equal(post?.slug, "on-slow-software");
        assert.ok(post?.excerpt?.startsWith("There is a particular kind"));

        const html = post!.content_html!;
        assert.ok(html.includes("<h2>What it costs</h2>"), "heading");
        assert.ok(html.includes("<strong>impatience</strong>"), "bold");
        assert.ok(html.includes("<ul>"), "list");
        // The parenthesised URL must survive intact.
        assert.ok(
          html.includes('href="https://example.com/earlier_(part-two)"'),
          "link with balanced parens",
        );
        assert.ok(html.includes('<img src="https://example.com/diagram.png"'), "image");

        const nested = report.items.find((i) => i.file === "A Nested Draft")!;
        assert.equal(nested.folder, "Essays");
      } finally {
        fake.restore();
      }
    });

    it("is safe to run twice", async () => {
      const files: FakeEntry[] = [
        { id: "doc-1", name: "Repeat", mimeType: DOC, parent: "root", body: "# Repeat\n\nText." },
      ];

      let fake = fakeGoogle(files);
      const first = await importFromDrive(db(), createDriveClient(account), "root");
      fake.restore();
      resetTokenCache();

      fake = fakeGoogle(files);
      try {
        const second = await importFromDrive(db(), createDriveClient(account), "root");
        assert.equal(first.counts.created, 1);
        assert.equal(second.counts.created, 0);
        assert.equal(second.counts.unchanged, 1);
        // The unchanged document is not fetched a second time.
        assert.deepEqual(fake.exported, []);
      } finally {
        fake.restore();
      }
    });
  },
);
