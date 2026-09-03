import { signToken, verifyToken } from "../signed-token";

/**
 * Every link in an email is a signed capability.
 *
 * Nothing in an email can carry a session, and none of these links may be
 * guessable: a confirmation link that could be forged would let anyone
 * subscribe an address they do not own, and a click tracker that took an
 * arbitrary `?url=` would be an open redirect on the blog's own domain.
 * Signing the destination *into* the token closes both.
 */

/** Confirmation links expire; a stale one should re-prompt rather than confirm. */
export const CONFIRM_TTL_SECONDS = 60 * 60 * 24 * 14;

type SubscriberPayload = { s: string };
type OpenPayload = { d: string };
type ClickPayload = { d: string; u: string };

export const createConfirmToken = (subscriberId: string, secret: string) =>
  signToken<SubscriberPayload>(
    "newsletter-confirm",
    { s: subscriberId },
    secret,
    CONFIRM_TTL_SECONDS,
  );

export const readConfirmToken = async (token: string | null, secret: string) =>
  (await verifyToken<SubscriberPayload>("newsletter-confirm", token, secret))?.s ?? null;

/**
 * Unsubscribe tokens never expire.
 *
 * An email from two years ago must still have a working unsubscribe link —
 * that is the whole bargain of sending to someone, and RFC 8058's one-click
 * header depends on it. The token authorises exactly one thing: removing that
 * address from the list.
 */
export const createUnsubscribeToken = (subscriberId: string, secret: string) =>
  signToken<SubscriberPayload>("newsletter-unsubscribe", { s: subscriberId }, secret);

export const readUnsubscribeToken = async (token: string | null, secret: string) =>
  (await verifyToken<SubscriberPayload>("newsletter-unsubscribe", token, secret))?.s ??
  null;

export const createOpenToken = (sendId: string, secret: string) =>
  signToken<OpenPayload>("newsletter-open", { d: sendId }, secret);

export const readOpenToken = async (token: string | null, secret: string) =>
  (await verifyToken<OpenPayload>("newsletter-open", token, secret))?.d ?? null;

export const createClickToken = (sendId: string, url: string, secret: string) =>
  signToken<ClickPayload>("newsletter-click", { d: sendId, u: url }, secret);

export const readClickToken = (token: string | null, secret: string) =>
  verifyToken<ClickPayload>("newsletter-click", token, secret);
