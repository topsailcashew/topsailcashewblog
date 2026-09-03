import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { MAX_UPLOAD_BYTES } from "./src/lib/upload-limits";

const nextConfig: NextConfig = {
  experimental: {
    // With a proxy in place Next buffers the whole request body, capped at
    // 10MB by default — which truncates a 10MB upload once multipart overhead
    // is added, and the failure surfaces as an unparseable body. Give the cap
    // headroom above our own limit so the size check in /api/media is the one
    // that actually fires.
    proxyClientMaxBodySize: MAX_UPLOAD_BYTES + 2 * 1024 * 1024,
  },

  /*
    WebFinger has to answer at /.well-known/webfinger — that path is baked
    into every fediverse client, and it is the only way `@name@host` resolves
    to anything. A directory beginning with a dot is not a route Next will
    reliably pick up, so the handler lives at /api/webfinger and this points
    the well-known path at it.
  */
  async rewrites() {
    return [{ source: "/.well-known/webfinger", destination: "/api/webfinger" }];
  },

  async redirects() {
    return [
      // The archive was /stories before the nav was reworked. Permanent, so
      // any link already in the wild keeps its search ranking.
      { source: "/stories", destination: "/articles", permanent: true },
    ];
  },
};

// Gives `next dev` the same Cloudflare bindings the Worker gets (R2, etc.) by
// running them through a local miniflare instance. No-op in production builds.
void initOpenNextCloudflareForDev();

export default nextConfig;
