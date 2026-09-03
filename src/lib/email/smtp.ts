import { base64 } from "./mime";

/**
 * A minimal SMTP client, spoken over a raw TCP socket.
 *
 * ## Why write one
 *
 * The Workers runtime has no Node `net`, so no existing SMTP package runs
 * here. What it does have is `cloudflare:sockets`, which gives a plaintext
 * socket that can be upgraded in place with `startTls()` — exactly the shape
 * STARTTLS wants. The conversation an authenticated submission needs is nine
 * commands long, so this is a smaller thing to own than a dependency would be.
 *
 * ## What it deliberately does not do
 *
 * No pipelining, no CHUNKING, no connection reuse across messages. Sends are
 * one connection per message. For a list of a few thousand that costs a
 * handshake per recipient and buys a failure that isolates to one address
 * instead of poisoning a batch.
 *
 * Port 25 is blocked outbound on Cloudflare's network. Submission ports —
 * 587 with STARTTLS, or 465 with implicit TLS — are the ones that work, and
 * are what every provider documents anyway.
 */

export type SmtpSocketLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls?: () => SmtpSocketLike;
  close: () => Promise<void>;
};

export type SmtpConnect = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean },
) => SmtpSocketLike;

export type SmtpTransportOptions = {
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  username?: string;
  password?: string | null;
  /** What to announce in EHLO. Defaults to the sending domain. */
  clientName?: string;
  /** Overrides the socket factory. The tests pass a scripted server through here. */
  connect?: SmtpConnect;
  /** Whole-conversation budget. A silent server must not hold the request open. */
  timeoutMs?: number;
};

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

/**
 * Resolves the runtime's socket factory.
 *
 * The specifier is held in a variable so no bundler tries to resolve
 * `cloudflare:` at build time — under webpack it would fail outright, and
 * under esbuild it would be inlined into a module Node cannot load. Kept as a
 * runtime import, it simply is not reached outside the Worker.
 */
async function runtimeConnect(): Promise<SmtpConnect> {
  const specifier = "cloudflare:sockets";
  try {
    const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as {
      connect: SmtpConnect;
    };
    return mod.connect;
  } catch {
    throw new SmtpError(
      "No TCP socket support in this runtime. SMTP sending only works on the Cloudflare Worker.",
    );
  }
}

/** One line-oriented read side over the socket. */
class LineReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) {
        if (this.buffer === "") throw new SmtpError("Server closed the connection");
        const rest = this.buffer;
        this.buffer = "";
        return rest;
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  release(): void {
    this.reader.releaseLock();
  }
}

type Reply = { code: number; lines: string[] };

export type SentMessage = { messageId: string; response: string };

/**
 * Delivers one message. Resolves on a 250 for the final dot; throws otherwise.
 *
 * `raw` must already be a complete RFC 5322 message with CRLF endings — see
 * buildMimeMessage. Dot-stuffing is applied here because it is a property of
 * the transport, not of the message.
 */
export async function sendViaSmtp(
  options: SmtpTransportOptions,
  envelope: { from: string; to: string; raw: string },
): Promise<SentMessage> {
  const connect = options.connect ?? (await runtimeConnect());
  const timeoutMs = options.timeoutMs ?? 20_000;

  let socket = connect(
    { hostname: options.host, port: options.port },
    {
      secureTransport:
        options.security === "tls"
          ? "on"
          : options.security === "starttls"
            ? "starttls"
            : "off",
      allowHalfOpen: false,
    },
  );

  let reader = new LineReader(socket.readable.getReader());
  let writer = socket.writable.getWriter();
  const encoder = new TextEncoder();

  async function read(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const line = await reader.readLine();
      lines.push(line);
      // "250-CAPABILITY" continues; "250 CAPABILITY" is the last one.
      if (line.length < 4 || line[3] !== "-") {
        const code = Number(line.slice(0, 3));
        return { code: Number.isFinite(code) ? code : 0, lines };
      }
    }
  }

  async function expect(codes: number[], context: string): Promise<Reply> {
    const reply = await read();
    if (!codes.includes(reply.code)) {
      throw new SmtpError(
        `${context} failed: ${reply.lines.join(" ").trim()}`,
        reply.code,
      );
    }
    return reply;
  }

  async function send(command: string): Promise<void> {
    await writer.write(encoder.encode(`${command}\r\n`));
  }

  const run = async (): Promise<SentMessage> => {
    await expect([220], "Greeting");

    const clientName = options.clientName || hostOf(envelope.from);
    await send(`EHLO ${clientName}`);
    let greeting = await expect([250], "EHLO");

    if (options.security === "starttls") {
      await send("STARTTLS");
      await expect([220], "STARTTLS");

      if (!socket.startTls) {
        throw new SmtpError("This socket cannot be upgraded to TLS");
      }
      // The upgraded socket is a different object with fresh streams, so both
      // locks have to be surrendered before the swap or the new reader throws.
      reader.release();
      writer.releaseLock();
      socket = socket.startTls();
      reader = new LineReader(socket.readable.getReader());
      writer = socket.writable.getWriter();

      // EHLO again: capabilities before and after the upgrade are allowed to
      // differ, and AUTH is routinely only offered on the encrypted side.
      await send(`EHLO ${clientName}`);
      greeting = await expect([250], "EHLO (after STARTTLS)");
    }

    if (options.username && options.password) {
      await authenticate(greeting, options.username, options.password);
    }

    await send(`MAIL FROM:<${envelope.from}>`);
    await expect([250], "MAIL FROM");

    await send(`RCPT TO:<${envelope.to}>`);
    await expect([250, 251], "RCPT TO");

    await send("DATA");
    await expect([354], "DATA");

    await writer.write(encoder.encode(dotStuff(envelope.raw)));
    await writer.write(encoder.encode("\r\n.\r\n"));
    const accepted = await expect([250], "Message body");

    await send("QUIT");
    // A server that drops the connection instead of answering QUIT has still
    // accepted the message; the 250 above is the receipt that matters.
    await read().catch(() => undefined);

    return {
      messageId: envelope.from,
      response: accepted.lines.join(" ").trim(),
    };
  };

  async function authenticate(
    greeting: Reply,
    username: string,
    password: string,
  ): Promise<void> {
    const capabilities = greeting.lines.join(" ").toUpperCase();

    if (capabilities.includes("AUTH") && capabilities.includes("PLAIN")) {
      const credential = base64(
        new TextEncoder().encode(`\0${username}\0${password}`),
      );
      await send(`AUTH PLAIN ${credential}`);
      await expect([235], "AUTH PLAIN");
      return;
    }

    if (capabilities.includes("LOGIN")) {
      await send("AUTH LOGIN");
      await expect([334], "AUTH LOGIN");
      await send(base64(new TextEncoder().encode(username)));
      await expect([334], "AUTH LOGIN (username)");
      await send(base64(new TextEncoder().encode(password)));
      await expect([235], "AUTH LOGIN (password)");
      return;
    }

    throw new SmtpError(
      "Server advertised no authentication method this client supports",
    );
  }

  try {
    return await withTimeout(run(), timeoutMs);
  } finally {
    // Best effort: the message is already accepted or already lost by here,
    // and a close that throws must not mask the real error.
    try {
      await socket.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * A line consisting of a single "." terminates DATA, so any body line that
 * begins with one gets a second. The receiver strips it back off.
 */
export function dotStuff(raw: string): string {
  return raw.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
}

function hostOf(email: string): string {
  return email.split("@")[1] ?? "localhost";
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SmtpError(`SMTP conversation timed out after ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
