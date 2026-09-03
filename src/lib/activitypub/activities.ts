import { absoluteUrl } from "../site";
import { actorUrl, followersUrl } from "./actor";

/**
 * Posts as ActivityStreams objects.
 *
 * ## Note, not Article
 *
 * `Article` is the semantically correct type for a blog post, and almost
 * nothing renders it. Mastodon shows an Article as a bare link with no text;
 * Note is what every client in the network displays properly. So a post
 * federates as a Note carrying a summary and a link home, which is the shape
 * a timeline can actually use — the full piece lives at the URL, where it was
 * going to be read anyway.
 *
 * ## Public addressing
 *
 * The magic `#Public` collection is what makes a post appear in a timeline
 * rather than only in a mention. `to` public, `cc` followers is the
 * conventional pairing: publicly visible, and pushed to the people who asked
 * for it.
 */

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

export type FederatedPost = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  published_at: string | null;
  cover_image_url: string | null;
  tags: { name: string; slug: string }[];
};

/** Stable, derived from the post id, so a redelivery is recognisably the same. */
export const noteId = (postId: string) => absoluteUrl(`/ap/notes/${postId}`);
export const createId = (postId: string) => absoluteUrl(`/ap/notes/${postId}/create`);

export function buildNote(post: FederatedPost) {
  const url = absoluteUrl(`/${post.slug}`);
  const published = post.published_at ?? new Date().toISOString();

  return {
    id: noteId(post.id),
    type: "Note",
    attributedTo: actorUrl(),
    published,
    url,
    to: [PUBLIC],
    cc: [followersUrl()],
    /*
      Escaped, and limited to the two tags every client renders. Mastodon
      sanitises incoming HTML to roughly this set anyway; sending more means
      sending markup that will be stripped, and sending unescaped text means a
      title containing "<" arrives broken.
    */
    content: `<p><strong>${escapeHtml(post.title)}</strong></p>${
      post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ""
    }<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
    // The plain-text summary doubles as the content warning slot; leaving it
    // unset is right for a post that needs no warning.
    contentMap: { en: undefined },
    tag: post.tags.map((tag) => ({
      type: "Hashtag",
      name: `#${tag.slug.replace(/-/g, "")}`,
      href: absoluteUrl(`/tag/${tag.slug}`),
    })),
    attachment: post.cover_image_url
      ? [
          {
            type: "Document",
            mediaType: "image/jpeg",
            url: toAbsolute(post.cover_image_url),
            // Empty rather than absent: the cover is decorative here, since
            // the title and summary are already in the content.
            name: "",
          },
        ]
      : [],
  };
}

export function buildCreate(post: FederatedPost) {
  const note = buildNote(post);
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: createId(post.id),
    type: "Create",
    actor: actorUrl(),
    published: note.published,
    to: note.to,
    cc: note.cc,
    object: note,
  };
}

/** The reply to a Follow. Sent to the follower's inbox to complete the handshake. */
export function buildAccept(followActivity: { id?: string; actor?: string }) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: absoluteUrl(`/ap/accepts/${crypto.randomUUID()}`),
    type: "Accept",
    actor: actorUrl(),
    to: [followActivity.actor],
    object: followActivity,
  };
}

export function buildOutbox(posts: FederatedPost[], total: number) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: absoluteUrl("/ap/outbox"),
    // Ordered, newest first, and inlined rather than paged: a personal blog's
    // whole archive is smaller than one page of a busy account's outbox.
    type: "OrderedCollection",
    totalItems: total,
    orderedItems: posts.map(buildCreate),
  };
}

export function buildFollowers(actorUris: string[], total: number) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: followersUrl(),
    type: "OrderedCollection",
    totalItems: total,
    orderedItems: actorUris,
  };
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
