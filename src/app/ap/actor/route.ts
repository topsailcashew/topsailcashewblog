import { getDb } from "@/db/client";
import { AP_CONTENT_TYPE, buildActor } from "@/lib/activitypub/actor";
import { ensureKeyPair, loadFediverseSettings } from "@/lib/activitypub/keys";
import { getSessionSecret } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The actor document. The blog's identity in the fediverse.
 *
 * Generating the key on first fetch rather than at deploy time keeps the
 * feature off until it is switched on — a blog that never enables federation
 * never mints a key it would then have to protect.
 */
export async function GET() {
  const db = getDb();
  const settings = await loadFediverseSettings(db).catch(() => null);
  if (!settings?.enabled) return new Response("Not found", { status: 404 });

  const secret = getSessionSecret();
  if (!secret) return new Response("Not configured", { status: 500 });

  const { publicKeyPem } = await ensureKeyPair(db, secret);

  return Response.json(buildActor({ ...settings, publicKeyPem }), {
    headers: {
      "content-type": AP_CONTENT_TYPE,
      // Remote servers cache this and re-fetch on a signature failure; an hour
      // is long enough to matter and short enough to recover from a rotation.
      "cache-control": "public, max-age=3600",
    },
  });
}
