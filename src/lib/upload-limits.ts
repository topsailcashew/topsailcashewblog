/**
 * Shared by `next.config.ts` and the upload route, so the proxy body cap and
 * the application's own limit can never drift apart.
 *
 * 10 MB: comfortably above a full-resolution phone photo, well under R2's
 * single-part upload ceiling.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
