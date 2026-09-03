import { getDb } from "@/db/client";
import {
  SettingsForm,
  type FediverseView,
} from "@/components/admin/SettingsForm";
import { handle as fediverseHandle } from "@/lib/activitypub/actor";
import { countFollowers } from "@/lib/activitypub/delivery";
import { loadFediverseSettings } from "@/lib/activitypub/keys";
import {
  DEFAULT_NEWSLETTER,
  loadNewsletterSettings,
  loadSmtpSettings,
  redactSmtp,
  type NewsletterSettings,
  type RedactedSmtp,
} from "@/lib/email/config";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  let smtp: RedactedSmtp | null = null;
  let newsletter: NewsletterSettings = DEFAULT_NEWSLETTER;
  let fediverse: FediverseView | null = null;
  let error: string | null = null;

  try {
    const db = getDb();
    const [loadedSmtp, loadedNewsletter, loadedFediverse, followers] =
      await Promise.all([
        loadSmtpSettings(db),
        loadNewsletterSettings(db),
        loadFediverseSettings(db),
        countFollowers(db),
      ]);
    smtp = redactSmtp(loadedSmtp);
    newsletter = loadedNewsletter;
    fediverse = {
      enabled: loadedFediverse.enabled,
      username: loadedFediverse.username,
      summary: loadedFediverse.summary,
      handle: `@${fediverseHandle(loadedFediverse)}`,
      has_key: Boolean(loadedFediverse.publicKeyPem),
      followers,
    };
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not reach the database";
  }

  return (
    <main className="admin-main admin-main--narrow">
      <div className="admin-head">
        <h1 className="admin-title">Settings</h1>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {smtp && fediverse && (
        <SettingsForm
          initialSmtp={smtp}
          initialNewsletter={newsletter}
          initialFediverse={fediverse}
        />
      )}
    </main>
  );
}
