import { getDb } from "@/db/client";
import { handle, json } from "@/lib/http";
import { driveFolderId, driveSetupStatus } from "@/lib/drive-config";
import { serviceAccountFromEnv } from "@/lib/google-auth";
import { countImportedPosts } from "@/lib/drive-import";

export const dynamic = "force-dynamic";

/**
 * GET /api/drive — whether the integration is set up, and what it can see.
 *
 * Never returns the credentials themselves; only whether each part is present
 * and the service account address, which the writer needs in order to share
 * the folder with it.
 */
export const GET = handle(async () => {
  const account = serviceAccountFromEnv();
  return json({
    status: driveSetupStatus(),
    client_email: account?.clientEmail ?? null,
    folder_id: driveFolderId() ?? null,
    imported_posts: await countImportedPosts(getDb()).catch(() => 0),
  });
});
