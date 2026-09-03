import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { handle, json, notFound } from "@/lib/http";
import {
  deleteSubscriber,
  getSubscriber,
  getSubscriberMetrics,
  getSubscriberTimeline,
  serializeSubscriber,
} from "@/lib/subscribers";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function subscriberId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return uuidSchema.parse(id);
}

/** GET /api/subscribers/:id — the profile: aggregates plus the event feed. */
export const GET = handle(async (_request: NextRequest, context: RouteContext) => {
  const id = await subscriberId(context);
  const db = getDb();

  const row = await getSubscriber(db, id);
  if (!row) throw notFound("Subscriber");

  const [metrics, timeline] = await Promise.all([
    getSubscriberMetrics(db, id),
    getSubscriberTimeline(db, id),
  ]);

  return json({ subscriber: serializeSubscriber(row), metrics, timeline });
});

/**
 * DELETE /api/subscribers/:id — removes the person and their history.
 *
 * A real delete rather than a status change, because this is the endpoint an
 * erasure request is answered with. Unsubscribing is what the reader does;
 * this is what the operator does when asked to forget them, and leaving the
 * event log behind would not be forgetting them.
 */
export const DELETE = handle(async (_request: NextRequest, context: RouteContext) => {
  await deleteSubscriber(getDb(), await subscriberId(context));
  return new Response(null, { status: 204 });
});
