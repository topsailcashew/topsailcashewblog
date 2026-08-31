import type { MetadataRoute } from "next";
import { absoluteUrl, siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      /*
        Admin and the JSON API are behind a session, so this is not what keeps
        them private — it keeps them out of the index and stops crawlers
        spending the site's request budget on pages that only return 401.
        /preview/ is listed because a token holder might paste a link
        somewhere a crawler can read it.
      */
      disallow: ["/admin", "/api/", "/preview/", "/search"],
    },
    // Omitted rather than emitted relative when the origin is unconfigured: a
    // relative Sitemap line is invalid and crawlers discard the whole file.
    sitemap: siteUrl() ? absoluteUrl("/sitemap.xml") : undefined,
  };
}
