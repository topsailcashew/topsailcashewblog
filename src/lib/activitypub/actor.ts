import { absoluteUrl, siteConfig, siteUrl } from "../site";
import type { FediverseSettings } from "./keys";

/**
 * This blog's Actor, and how to reach other people's.
 *
 * An ActivityPub actor is just a JSON document at a stable URL, carrying an
 * inbox to deliver to, an outbox to read from, and the public key that
 * verifies anything it signs. Everything else in the protocol is built on
 * fetching one of these and trusting what it says.
 */

export const AP_CONTENT_TYPE =
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

/** What a remote server sends in `Accept` when it wants ActivityStreams. */
export function wantsActivityJson(accept: string | null): boolean {
  if (!accept) return false;
  return /application\/(activity\+json|ld\+json)/i.test(accept);
}

export const actorUrl = () => absoluteUrl("/ap/actor");
export const keyId = () => `${actorUrl()}#main-key`;
export const inboxUrl = () => absoluteUrl("/ap/inbox");
export const outboxUrl = () => absoluteUrl("/ap/outbox");
export const followersUrl = () => absoluteUrl("/ap/followers");

/** `@name@host` — how a person types this blog into their own client. */
export function handle(settings: FediverseSettings): string {
  return `${settings.username}@${hostname()}`;
}

export function hostname(): string {
  try {
    return new URL(siteUrl() || "https://localhost").host;
  } catch {
    return "localhost";
  }
}

export function buildActor(settings: FediverseSettings) {
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id: actorUrl(),
    /*
      Person rather than Service or Application. Some instances quietly
      down-rank or hide automated actors, and this is one person's writing
      published under their own name — the accurate answer is also the useful
      one.
    */
    type: "Person",
    preferredUsername: settings.username,
    name: siteConfig.author,
    summary: settings.summary,
    url: siteUrl() || undefined,
    manuallyApprovesFollowers: false,
    discoverable: true,
    inbox: inboxUrl(),
    outbox: outboxUrl(),
    followers: followersUrl(),
    // Declared and empty. Omitting them makes some clients show an error on
    // the profile rather than simply nothing.
    following: absoluteUrl("/ap/following"),
    publicKey: {
      id: keyId(),
      owner: actorUrl(),
      publicKeyPem: settings.publicKeyPem ?? "",
    },
    icon: {
      type: "Image",
      mediaType: "image/png",
      url: absoluteUrl("/og/default.png"),
    },
    attachment: [
      {
        type: "PropertyValue",
        name: "Blog",
        value: `<a href="${siteUrl()}" rel="me">${hostname()}</a>`,
      },
    ],
  };
}

/**
 * The WebFinger response.
 *
 * This is what turns `@name@host` into a URL. A client that has only the
 * handle asks the host for it, and the `self` link with an activity+json type
 * is the one that leads to the actor — the others are what make the handle
 * clickable in a browser.
 */
export function buildWebFinger(settings: FediverseSettings) {
  return {
    subject: `acct:${handle(settings)}`,
    aliases: [actorUrl(), siteUrl()].filter(Boolean),
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: actorUrl(),
      },
      {
        rel: "http://webfinger.net/rel/profile-page",
        type: "text/html",
        href: siteUrl() || actorUrl(),
      },
    ],
  };
}

export type RemoteActor = {
  id: string;
  inbox: string;
  sharedInbox: string | null;
  publicKeyPem: string | null;
  handle: string | null;
};

/**
 * Fetches a remote actor.
 *
 * Used both to answer a Follow (we need somewhere to deliver to) and to verify
 * an inbound signature (we need the key). Failures are returned as null rather
 * than thrown: a dead instance is the normal case in federation, not an
 * exception.
 */
export async function fetchRemoteActor(url: string): Promise<RemoteActor | null> {
  if (!/^https:\/\//.test(url)) return null;

  try {
    const response = await fetch(stripFragment(url), {
      headers: { accept: "application/activity+json" },
      // Federation is best-effort; a slow instance must not hold a request open.
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;

    const document = (await response.json()) as {
      id?: string;
      inbox?: string;
      preferredUsername?: string;
      publicKey?: { publicKeyPem?: string; owner?: string };
      endpoints?: { sharedInbox?: string };
    };

    if (!document.id || !document.inbox) return null;

    return {
      id: document.id,
      inbox: document.inbox,
      sharedInbox: document.endpoints?.sharedInbox ?? null,
      publicKeyPem: document.publicKey?.publicKeyPem ?? null,
      handle: document.preferredUsername
        ? `${document.preferredUsername}@${safeHost(document.id)}`
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * A key id is the actor URL plus a fragment (`#main-key`). The fragment is a
 * pointer *within* the document, so it has to come off before fetching — some
 * servers 404 on it, and none need it.
 */
function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}
