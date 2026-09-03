/**
 * Builds an RFC 5322 message.
 *
 * Hand-rolled rather than pulled from a package because the Worker bundle has
 * a hard 3 MB ceiling and this is the whole of what we need: one
 * multipart/alternative body, headers that survive UTF-8, and CRLF line
 * endings throughout.
 *
 * Bodies are base64-encoded rather than quoted-printable. Both are legal;
 * base64 is a dozen lines instead of sixty and cannot produce a line over 998
 * octets, which is the limit that actually bites when a post contains a long
 * URL.
 */

export type MailAddress = { name?: string | null; email: string };

export type MimeMessage = {
  from: MailAddress;
  to: MailAddress;
  replyTo?: MailAddress | null;
  subject: string;
  text: string;
  html: string;
  /** Extra headers — List-Unsubscribe and friends. */
  headers?: Record<string, string>;
};

const CRLF = "\r\n";

/**
 * RFC 2047 encoded-word, for header values that are not pure ASCII.
 *
 * Left alone when it is already ASCII: an encoded-word where none is needed
 * is legal but shows up verbatim in a few older clients.
 */
export function encodeHeaderValue(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value;
  return `=?UTF-8?B?${base64(new TextEncoder().encode(value))}?=`;
}

export function formatAddress(address: MailAddress): string {
  const email = address.email.trim();
  if (!address.name) return email;
  const name = encodeHeaderValue(address.name);
  // A display name that survived unencoded still needs quoting: a bare comma
  // or colon in it would otherwise read as an address-list separator.
  const quoted = /^[\w .'-]+$/.test(name) ? name : `"${name.replace(/["\\]/g, "")}"`;
  return `${quoted} <${email}>`;
}

/** Strips CR and LF so a header value cannot inject headers of its own. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildMimeMessage(message: MimeMessage, messageId: string): string {
  const boundary = `--=_topsail_${crypto.randomUUID().replace(/-/g, "")}`;

  const headers: [string, string][] = [
    ["From", formatAddress(message.from)],
    ["To", formatAddress(message.to)],
    ["Subject", encodeHeaderValue(message.subject)],
    ["Date", new Date().toUTCString()],
    ["Message-ID", messageId],
    ["MIME-Version", "1.0"],
    ["Content-Type", `multipart/alternative; boundary="${boundary}"`],
  ];
  if (message.replyTo) headers.push(["Reply-To", formatAddress(message.replyTo)]);
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    headers.push([name, value]);
  }

  const head = headers
    .map(([name, value]) => `${name}: ${headerSafe(value)}`)
    .join(CRLF);

  /*
    Plain text first. multipart/alternative is ordered least-rich to
    most-rich, and a client that renders the *first* part it understands
    rather than the last is a client that would otherwise show raw HTML.
  */
  const parts = [
    part(boundary, "text/plain; charset=UTF-8", message.text),
    part(boundary, "text/html; charset=UTF-8", message.html),
  ].join("");

  return `${head}${CRLF}${CRLF}${parts}--${boundary}--${CRLF}`;
}

function part(boundary: string, contentType: string, body: string): string {
  return [
    `--${boundary}`,
    `Content-Type: ${contentType}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap(base64(new TextEncoder().encode(body))),
    "",
  ].join(CRLF);
}

/** 76 characters per line, as RFC 2045 requires of base64 bodies. */
function wrap(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join(CRLF);
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a large array into String.fromCharCode blows the
  // argument limit somewhere north of 100 kB, and a post easily exceeds that.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** A Message-ID whose right-hand side is the sending domain. */
export function buildMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] ?? "localhost";
  return `<${crypto.randomUUID()}@${domain}>`;
}
