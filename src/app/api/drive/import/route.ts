import { getDb } from "@/db/client";
import { ApiError, handle, json } from "@/lib/http";
import { driveFolderId, driveSetupStatus } from "@/lib/drive-config";
import { importFromDrive } from "@/lib/drive-import";
import { createDriveClient, DriveError } from "@/lib/google-drive";
import { GoogleAuthError, serviceAccountFromEnv } from "@/lib/google-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/drive/import — walk the folder and file what is there as drafts.
 *
 * Everything it creates is a draft, so this route publishes nothing and cannot
 * change what a reader sees. There is deliberately no cache invalidation here
 * for that reason.
 */
export const POST = handle(async () => {
  const status = driveSetupStatus();
  if (status !== "ready") {
    throw new ApiError(
      400,
      status === "missing-credentials"
        ? "Google Drive is not connected. Set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY."
        : "Set GOOGLE_DRIVE_FOLDER_ID to the folder you want to import from.",
    );
  }

  const account = serviceAccountFromEnv()!;
  try {
    const report = await importFromDrive(
      getDb(),
      createDriveClient(account),
      driveFolderId()!,
    );
    return json({ report });
  } catch (cause) {
    /*
      These carry the only diagnosis the writer will get — which half of the
      setup is wrong, and what to do about it. Without this they fall through
      to the generic 500 handler and the message is lost to the server log.
    */
    if (cause instanceof GoogleAuthError) {
      throw new ApiError(400, cause.message);
    }
    if (cause instanceof DriveError) {
      // 502: this app is fine, the service it depends on refused.
      throw new ApiError(cause.status === 404 || cause.status === 403 ? 400 : 502, cause.message);
    }
    throw cause;
  }
});
