import { getDb } from "@/db/client";
import { loadNewsletterSettings } from "@/lib/email/config";
import { SubscribeForm } from "./SubscribeForm";

/**
 * Renders the signup form only when the newsletter is actually switched on.
 *
 * A server component wrapping a client one, so the "is it on" check never
 * ships to the browser and an unconfigured blog carries no signup markup at
 * all — rather than rendering a form whose submission would 404.
 */
export async function SubscribeSection() {
  // Resolved before any JSX exists: constructing an element inside a try/catch
  // catches nothing, because React renders it long after the block has exited.
  const settings = await loadNewsletterSettings(getDb()).catch(() => null);
  if (!settings?.enabled) return null;
  return <SubscribeForm pitch={settings.pitch} />;
}
