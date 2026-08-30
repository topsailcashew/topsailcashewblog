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
};

// Gives `next dev` the same Cloudflare bindings the Worker gets (R2, etc.) by
// running them through a local miniflare instance. No-op in production builds.
void initOpenNextCloudflareForDev();

export default nextConfig;
