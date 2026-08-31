import Script from "next/script";

/**
 * Cloudflare Web Analytics.
 *
 * Chosen over a self-hosted counter because it costs the Worker nothing: the
 * beacon goes straight to Cloudflare from the browser, so no request touches
 * our code, our database or the request budget. It sets no cookies and builds
 * no cross-site profile, so there is nothing to put a consent banner in front
 * of.
 *
 * Off unless NEXT_PUBLIC_CF_ANALYTICS_TOKEN is set — a blog running locally or
 * on a fork should not be reporting into someone else's dashboard.
 */
export function Analytics() {
  const token = process.env.NEXT_PUBLIC_CF_ANALYTICS_TOKEN;
  if (!token) return null;

  return (
    <Script
      src="https://static.cloudflareinsights.com/beacon.min.js"
      strategy="afterInteractive"
      data-cf-beacon={JSON.stringify({ token })}
    />
  );
}
