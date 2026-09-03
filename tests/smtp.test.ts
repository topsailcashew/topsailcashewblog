import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMessageId,
  buildMimeMessage,
  encodeHeaderValue,
  formatAddress,
} from "@/lib/email/mime";
import { dotStuff, sendViaSmtp, SmtpError, type SmtpSocketLike } from "@/lib/email/smtp";

/**
 * A scripted SMTP server.
 *
 * The point of these tests is the *conversation*: an SMTP client that gets the
 * command order or the expected reply codes wrong fails in production against
 * a real mail server and nowhere else. Driving it against a fake socket that
 * answers like a real server — including multi-line 250 capability replies,
 * which are the usual thing a hand-rolled client mishandles — exercises that
 * without needing a mail server in CI.
 */
function scriptedServer(script: [expect: RegExp | null, reply: string][]) {
  const received: string[] = [];
  let step = 0;
  let pushChunk: ((chunk: string) => void) | null = null;
  const pending: string[] = [];

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      pushChunk = (chunk: string) => controller.enqueue(new TextEncoder().encode(chunk));
      // The greeting arrives unprompted, before the client says anything.
      if (script[0][0] === null) {
        pushChunk(script[0][1]);
        step = 1;
      }
      for (const queued of pending) pushChunk(queued);
      pending.length = 0;
    },
  });

  let buffer = "";
  let inData = false;

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += new TextDecoder().decode(chunk);

      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.push(`<DATA>${buffer.slice(0, end)}`);
          buffer = buffer.slice(end + 5);
          inData = false;
          respond();
          continue;
        }

        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        received.push(line);
        if (/^DATA$/i.test(line)) {
          respond();
          inData = true;
          continue;
        }
        respond();
      }
    },
  });

  function respond() {
    const entry = script[step];
    if (!entry) return;
    const [expected, reply] = entry;
    if (expected) {
      assert.match(received[received.length - 1], expected, `step ${step}`);
    }
    step += 1;
    if (pushChunk) pushChunk(reply);
    else pending.push(reply);
  }

  const socket: SmtpSocketLike = {
    readable,
    writable,
    startTls: () => socket,
    close: async () => {},
  };

  return { socket, received };
}

describe("MIME", () => {
  it("leaves an ASCII header alone and encodes anything else", () => {
    assert.equal(encodeHeaderValue("Plain subject"), "Plain subject");
    const encoded = encodeHeaderValue("Café — a note");
    assert.match(encoded, /^=\?UTF-8\?B\?/);
    assert.equal(
      Buffer.from(encoded.slice(10, -2), "base64").toString("utf8"),
      "Café — a note",
    );
  });

  it("quotes a display name that would otherwise split the address list", () => {
    assert.equal(
      formatAddress({ name: "Senje, Nathaniel", email: "a@b.com" }),
      '"Senje, Nathaniel" <a@b.com>',
    );
    assert.equal(formatAddress({ email: "a@b.com" }), "a@b.com");
  });

  it("strips CR and LF out of header values so none can inject a header", () => {
    const raw = buildMimeMessage(
      {
        from: { email: "me@example.com" },
        to: { email: "you@example.com" },
        subject: "Hello\r\nBcc: sneaky@example.com",
        text: "body",
        html: "<p>body</p>",
      },
      "<id@example.com>",
    );
    const head = raw.split("\r\n\r\n")[0];
    assert.ok(!head.includes("Bcc:"), "injected header survived");
  });

  it("keeps every base64 body line inside the 76-character limit", () => {
    const raw = buildMimeMessage(
      {
        from: { email: "me@example.com" },
        to: { email: "you@example.com" },
        subject: "Long",
        text: "x".repeat(5000),
        html: `<p>${"y".repeat(5000)}</p>`,
      },
      "<id@example.com>",
    );
    for (const line of raw.split("\r\n")) {
      assert.ok(line.length <= 998, "line exceeds the RFC 5322 octet limit");
    }
  });

  it("round-trips a UTF-8 body through base64", () => {
    const raw = buildMimeMessage(
      {
        from: { email: "me@example.com" },
        to: { email: "you@example.com" },
        subject: "s",
        text: "naïve — résumé",
        html: "<p>naïve</p>",
      },
      "<id@example.com>",
    );
    const parts = raw.split(/Content-Transfer-Encoding: base64\r\n\r\n/);
    const textPart = parts[1].split("\r\n\r\n")[0].replace(/\r\n/g, "");
    assert.equal(Buffer.from(textPart, "base64").toString("utf8"), "naïve — résumé");
  });

  it("puts the sending domain in the Message-ID", () => {
    assert.match(buildMessageId("hello@blog.example"), /@blog\.example>$/);
  });
});

describe("dot stuffing", () => {
  it("doubles a leading dot so a body line cannot end the DATA block", () => {
    assert.equal(dotStuff("a\r\n.\r\nb"), "a\r\n..\r\nb");
    assert.equal(dotStuff(".hidden"), "..hidden");
    assert.equal(dotStuff("no dots here"), "no dots here");
  });
});

describe("SMTP conversation", () => {
  it("walks EHLO, STARTTLS, AUTH PLAIN, MAIL, RCPT, DATA in order", async () => {
    const { socket, received } = scriptedServer([
      [null, "220 mail.example.com ESMTP ready\r\n"],
      [/^EHLO /, "250-mail.example.com\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n"],
      [/^STARTTLS$/, "220 Go ahead\r\n"],
      [/^EHLO /, "250-mail.example.com\r\n250 AUTH PLAIN LOGIN\r\n"],
      [/^AUTH PLAIN /, "235 Authenticated\r\n"],
      [/^MAIL FROM:<me@example\.com>$/, "250 OK\r\n"],
      [/^RCPT TO:<you@example\.com>$/, "250 Accepted\r\n"],
      [/^DATA$/, "354 End with <CRLF>.<CRLF>\r\n"],
      [/^<DATA>Subject: Hi/, "250 2.0.0 Queued as ABC123\r\n"],
      [/^QUIT$/, "221 Bye\r\n"],
    ]);

    const result = await sendViaSmtp(
      {
        host: "mail.example.com",
        port: 587,
        security: "starttls",
        username: "user",
        password: "pass",
        connect: () => socket,
      },
      { from: "me@example.com", to: "you@example.com", raw: "Subject: Hi\r\n\r\nbody" },
    );

    assert.match(result.response, /Queued as ABC123/);
    assert.deepEqual(
      received.filter((line) => !line.startsWith("<DATA>")),
      [
        "EHLO example.com",
        "STARTTLS",
        "EHLO example.com",
        // \0user\0pass, base64.
        `AUTH PLAIN ${Buffer.from("\0user\0pass").toString("base64")}`,
        "MAIL FROM:<me@example.com>",
        "RCPT TO:<you@example.com>",
        "DATA",
        "QUIT",
      ],
    );
  });

  it("falls back to AUTH LOGIN when PLAIN is not offered", async () => {
    const { socket, received } = scriptedServer([
      [null, "220 ready\r\n"],
      [/^EHLO /, "250-host\r\n250 AUTH LOGIN\r\n"],
      [/^AUTH LOGIN$/, "334 VXNlcm5hbWU6\r\n"],
      [null, "334 UGFzc3dvcmQ6\r\n"],
      [null, "235 OK\r\n"],
      [/^MAIL FROM:/, "250 OK\r\n"],
      [/^RCPT TO:/, "250 OK\r\n"],
      [/^DATA$/, "354 go\r\n"],
      [null, "250 Queued\r\n"],
      [/^QUIT$/, "221 Bye\r\n"],
    ]);

    await sendViaSmtp(
      {
        host: "host",
        port: 587,
        security: "none",
        username: "user",
        password: "pass",
        connect: () => socket,
      },
      { from: "me@example.com", to: "you@example.com", raw: "Subject: x\r\n\r\nb" },
    );

    assert.equal(received[1], "AUTH LOGIN");
    assert.equal(received[2], Buffer.from("user").toString("base64"));
    assert.equal(received[3], Buffer.from("pass").toString("base64"));
  });

  it("reads a multi-line 250 as one reply rather than several", async () => {
    // The failure this guards against: treating "250-STARTTLS" as the final
    // line leaves the rest of the capability list in the buffer, and every
    // reply from then on is read one behind.
    const { socket } = scriptedServer([
      [null, "220 ready\r\n"],
      [
        /^EHLO /,
        "250-host\r\n250-PIPELINING\r\n250-SIZE 52428800\r\n250-8BITMIME\r\n250 HELP\r\n",
      ],
      [/^MAIL FROM:/, "250 OK\r\n"],
      [/^RCPT TO:/, "250 OK\r\n"],
      [/^DATA$/, "354 go\r\n"],
      [null, "250 Queued\r\n"],
      [/^QUIT$/, "221 Bye\r\n"],
    ]);

    const result = await sendViaSmtp(
      { host: "host", port: 25, security: "none", connect: () => socket },
      { from: "me@example.com", to: "you@example.com", raw: "Subject: x\r\n\r\nb" },
    );
    assert.match(result.response, /Queued/);
  });

  it("surfaces the server's own text when a command is rejected", async () => {
    const { socket } = scriptedServer([
      [null, "220 ready\r\n"],
      [/^EHLO /, "250 host\r\n"],
      [/^MAIL FROM:/, "550 5.7.1 Sender address rejected\r\n"],
    ]);

    await assert.rejects(
      sendViaSmtp(
        { host: "host", port: 25, security: "none", connect: () => socket },
        { from: "me@example.com", to: "you@example.com", raw: "Subject: x\r\n\r\nb" },
      ),
      (error: unknown) => {
        assert.ok(error instanceof SmtpError);
        assert.equal(error.code, 550);
        assert.match(error.message, /Sender address rejected/);
        return true;
      },
    );
  });

  it("refuses rather than sending in the clear when TLS cannot be started", async () => {
    const { socket } = scriptedServer([
      [null, "220 ready\r\n"],
      [/^EHLO /, "250-host\r\n250 STARTTLS\r\n"],
      [/^STARTTLS$/, "220 go\r\n"],
    ]);
    // A socket with no startTls: exactly what a plaintext transport gives.
    const plain: SmtpSocketLike = {
      readable: socket.readable,
      writable: socket.writable,
      close: async () => {},
    };

    await assert.rejects(
      sendViaSmtp(
        {
          host: "host",
          port: 587,
          security: "starttls",
          username: "u",
          password: "p",
          connect: () => plain,
        },
        { from: "me@example.com", to: "you@example.com", raw: "Subject: x\r\n\r\nb" },
      ),
      /cannot be upgraded to TLS/,
    );
  });

  it("gives up on a server that never answers", async () => {
    const socket: SmtpSocketLike = {
      readable: new ReadableStream<Uint8Array>({ start() {} }),
      writable: new WritableStream<Uint8Array>({ write() {} }),
      close: async () => {},
    };

    await assert.rejects(
      sendViaSmtp(
        {
          host: "host",
          port: 25,
          security: "none",
          connect: () => socket,
          timeoutMs: 50,
        },
        { from: "me@example.com", to: "you@example.com", raw: "x" },
      ),
      /timed out/,
    );
  });
});
