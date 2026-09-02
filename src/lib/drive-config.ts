import { serviceAccountFromEnv } from "./google-auth";

/** The Drive folder to walk. Its id is the last path segment of the folder URL. */
export function driveFolderId(): string | undefined {
  const value = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim();
  return value && value !== "" ? value : undefined;
}

export type DriveSetupStatus = "ready" | "missing-credentials" | "missing-folder";

/**
 * Which half of the setup is missing, if either.
 *
 * Reported rather than thrown: "not connected to Drive" is a normal state for
 * this blog, and the admin should say what to do about it instead of showing
 * an error.
 */
export function driveSetupStatus(): DriveSetupStatus {
  if (!serviceAccountFromEnv()) return "missing-credentials";
  if (!driveFolderId()) return "missing-folder";
  return "ready";
}
