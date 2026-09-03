import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { AP_CONTENT_TYPE, buildWebFinger, handle } from "@/lib/activitypub/actor";
import { loadFediverseSettings } from "@/lib/activitypub/keys";

export const dynamic = "force-dynamic";

/**
 * WebFinger, served at /.well-known/webfinger via a rewrite in next.config.ts.
 *
 * This is the lookup that turns `@name@host` — the only thing a person types
 * into their client — into an actor URL. Without it the blog is reachable only
 * by pasting a full URL, which nobody does.
 */
export async function GET(request: NextRequest) {
  const resource = new URL(request.url).searchParams.get("resource") ?? "";

  const settings = await loadFediverseSettings(getDb()).catch(() => null);
  if (!settings?.enabled) {
    return new Response("Not found", { status: 404 });
  }

  const wanted = resource.replace(/^acct:/, "").toLowerCase();
  if (wanted !== handle(settings).toLowerCase()) {
    // 404 rather than an error document: the question was "does this account
    // exist here", and the answer is no.
    return new Response("Not found", { status: 404 });
  }

  return Response.json(buildWebFinger(settings), {
    headers: {
      "content-type": "application/jrd+json; charset=utf-8",
      "cache-control": "public, max-age=3600",
      // Some clients resolve WebFinger from a browser context.
      "access-control-allow-origin": "*",
      vary: "accept",
      "x-activitypub": AP_CONTENT_TYPE,
    },
  });
}
