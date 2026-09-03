import { absoluteUrl, formatDate, siteConfig } from "../site";

/**
 * A post as an email.
 *
 * Email HTML is its own dialect: no external stylesheet, no `<style>` worth
 * relying on, no flexbox, and a body that has to survive Gmail stripping
 * anything it does not recognise. So everything here is inline styles on a
 * single centred column, with a plain-text alternative that is not an
 * afterthought — plenty of people read in a client that shows it, and every
 * spam filter reads it.
 */

const ACCENT = "#e2560f";
const INK = "#141414";
const MUTED = "#6b6b6b";
const RULE = "#e4e0da";

export type EmailPost = {
  title: string;
  slug: string;
  excerpt: string | null;
  content_html: string | null;
  cover_image_url: string | null;
  published_at: string | null;
};

export type RenderedEmail = { subject: string; html: string; text: string };

export function renderPostEmail(
  post: EmailPost,
  options: {
    footer: string;
    /**
     * Whether to print the "read it on the site" button.
     *
     * False for an email-only send: the post is not public, so the button
     * would land on a 404 — the one link in the email guaranteed to be broken.
     */
    siteLink?: boolean;
  },
): RenderedEmail {
  const siteLink = options.siteLink ?? true;
  const url = absoluteUrl(`/${post.slug}`);
  const dateline = post.published_at ? formatDate(post.published_at) : "";

  const body = restyleBodyHtml(post.content_html ?? "");

  const html = shell(`
    <p style="margin:0 0 8px;font:500 12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${MUTED}">
      ${escapeHtml(siteConfig.name)}${dateline ? ` &middot; ${escapeHtml(dateline)}` : ""}
    </p>
    <h1 style="margin:0 0 20px;font:600 30px/1.18 Georgia,'Times New Roman',serif;color:${INK}">
      ${
        siteLink
          ? `<a href="${escapeAttr(url)}" style="color:${INK};text-decoration:none">${escapeHtml(post.title)}</a>`
          : escapeHtml(post.title)
      }
    </h1>
    ${
      post.cover_image_url
        ? `<img src="${escapeAttr(toAbsolute(post.cover_image_url))}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;margin:0 0 24px;border-radius:2px">`
        : ""
    }
    ${body}
    ${
      siteLink
        ? `<p style="margin:32px 0 0">
      <a href="${escapeAttr(url)}" style="display:inline-block;padding:11px 20px;background:${ACCENT};color:#fff;font:600 14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-decoration:none;border-radius:2px">Read it on the site</a>
    </p>`
        : ""
    }
  `, options.footer);

  return {
    subject: post.title,
    html,
    text: toPlainText(post, siteLink ? url : null, options.footer),
  };
}

/** The double opt-in email. One link, and nothing else to click. */
export function renderConfirmationEmail(confirmUrl: string): RenderedEmail {
  return {
    subject: `Confirm your subscription to ${siteConfig.name}`,
    html: shell(
      `
      <h1 style="margin:0 0 16px;font:600 26px/1.2 Georgia,'Times New Roman',serif;color:${INK}">One more click</h1>
      <p style="margin:0 0 24px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:${INK}">
        Confirm this address and you will get new writing from ${escapeHtml(siteConfig.name)} when it is finished. If you did not ask for this, ignore this email — nothing happens without the click.
      </p>
      <p style="margin:0">
        <a href="${escapeAttr(confirmUrl)}" style="display:inline-block;padding:11px 20px;background:${ACCENT};color:#fff;font:600 14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-decoration:none;border-radius:2px">Confirm subscription</a>
      </p>
      <p style="margin:24px 0 0;font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${MUTED};word-break:break-all">
        Or paste this into your browser:<br>${escapeHtml(confirmUrl)}
      </p>`,
      "",
    ),
    text: [
      "One more click.",
      "",
      `Confirm this address to get new writing from ${siteConfig.name}:`,
      confirmUrl,
      "",
      "If you did not ask for this, ignore this email — nothing happens without the click.",
    ].join("\n"),
  };
}

function shell(inner: string, footer: string): string {
  return `<!doctype html>
<html lang="${siteConfig.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(siteConfig.name)}</title></head>
<body style="margin:0;padding:0;background:#faf8f5">
<div style="max-width:600px;margin:0 auto;padding:40px 24px;background:#faf8f5">
${inner}
<hr style="margin:40px 0 20px;border:0;border-top:1px solid ${RULE}">
<p style="margin:0 0 8px;font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${MUTED}">${escapeHtml(footer)}</p>
<!--UNSUBSCRIBE-->
</div>
<!--PIXEL-->
</body></html>`;
}

/**
 * Rewrites the editor's output for email.
 *
 * The rendered HTML on the site gets its typography from a stylesheet that
 * will not be there. Rather than ship a second renderer, the tags the editor
 * can actually produce are given inline styles on the way past — which is
 * also why this is a fixed list rather than a general transform: the node set
 * is closed (see src/lib/tiptap-html.ts), so it can be enumerated.
 */
export function restyleBodyHtml(html: string): string {
  const serif = `font:400 17px/1.7 Georgia,'Times New Roman',serif;color:${INK}`;
  const replacements: [RegExp, string][] = [
    [/<p>/g, `<p style="margin:0 0 20px;${serif}">`],
    [/<h1>/g, `<h1 style="margin:32px 0 12px;font:600 24px/1.25 Georgia,serif;color:${INK}">`],
    [/<h2>/g, `<h2 style="margin:32px 0 12px;font:600 21px/1.3 Georgia,serif;color:${INK}">`],
    [/<h3>/g, `<h3 style="margin:28px 0 10px;font:600 18px/1.35 Georgia,serif;color:${INK}">`],
    [/<ul>/g, `<ul style="margin:0 0 20px;padding-left:22px;${serif}">`],
    [/<ol>/g, `<ol style="margin:0 0 20px;padding-left:22px;${serif}">`],
    [/<li>/g, `<li style="margin:0 0 6px">`],
    [
      /<blockquote>/g,
      `<blockquote style="margin:0 0 20px;padding:2px 0 2px 18px;border-left:3px solid ${ACCENT};font:italic 400 17px/1.6 Georgia,serif;color:${INK}">`,
    ],
    [
      /<pre>/g,
      `<pre style="margin:0 0 20px;padding:14px 16px;background:#f1ede7;border-radius:2px;overflow-x:auto;font:400 13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:${INK}">`,
    ],
    [/<hr>/g, `<hr style="margin:32px 0;border:0;border-top:1px solid ${RULE}">`],
    [/<img /g, `<img style="display:block;width:100%;max-width:552px;height:auto;margin:0 0 20px" `],
    [/<a /g, `<a style="color:${ACCENT}" `],
  ];
  return replacements.reduce((acc, [find, put]) => acc.replace(find, put), html);
}

/**
 * Per-recipient finishing: click tracking, the open pixel, and the
 * unsubscribe line.
 *
 * Split out from rendering because the campaign body is stored *once* — a
 * snapshot of what went out — while these three differ for every recipient.
 */
export function personalizeHtml(
  html: string,
  parts: { unsubscribeUrl: string; pixelUrl?: string | null; trackLink?: (url: string) => string },
): string {
  let output = html;

  if (parts.trackLink) {
    const track = parts.trackLink;
    output = output.replace(
      /href="(https?:\/\/[^"]+)"/g,
      (match, url: string) =>
        // The unsubscribe link is never wrapped. Bouncing it through a
        // tracker would make the one link a reader must always be able to
        // trust depend on the tracker still working.
        url.includes("/e/u?") ? match : `href="${escapeAttr(track(url))}"`,
    );
  }

  output = output.replace(
    "<!--UNSUBSCRIBE-->",
    `<p style="margin:0;font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${MUTED}">
      <a href="${escapeAttr(parts.unsubscribeUrl)}" style="color:${MUTED}">Unsubscribe</a>
    </p>`,
  );

  if (parts.pixelUrl) {
    output = output.replace(
      "<!--PIXEL-->",
      `<img src="${escapeAttr(parts.pixelUrl)}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0">`,
    );
  }

  return output;
}

export function personalizeText(text: string, unsubscribeUrl: string): string {
  return `${text}\n\nUnsubscribe: ${unsubscribeUrl}\n`;
}

function toPlainText(post: EmailPost, url: string | null, footer: string): string {
  const body = (post.content_html ?? "")
    .replace(/<\/(p|h1|h2|h3|li|blockquote|pre)>/g, "\n\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<li>/g, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return [
    post.title,
    "",
    body,
    "",
    ...(url ? [`Read it on the site: ${url}`, ""] : []),
    footer,
  ]
    .join("\n")
    .trim();
}

function toAbsolute(url: string): string {
  return /^https?:\/\//.test(url) ? url : absoluteUrl(url);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const escapeAttr = escapeHtml;
