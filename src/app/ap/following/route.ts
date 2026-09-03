import { AP_CONTENT_TYPE } from "@/lib/activitypub/actor";
import { absoluteUrl } from "@/lib/site";

export const dynamic = "force-static";

/**
 * Always empty, and deliberately present.
 *
 * This blog publishes; it does not read timelines. But the actor document has
 * to declare a `following` collection, and a declared URL that 404s makes
 * several clients render an error on the profile rather than simply a zero.
 */
export function GET() {
  return Response.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: absoluteUrl("/ap/following"),
      type: "OrderedCollection",
      totalItems: 0,
      orderedItems: [],
    },
    { headers: { "content-type": AP_CONTENT_TYPE } },
  );
}
