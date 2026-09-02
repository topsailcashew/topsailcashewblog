import { getDb } from "@/db/client";
import { handle, json } from "@/lib/http";
import { emptyTrash } from "@/lib/posts";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/posts/trash — purge every trashed post.
 *
 * A fixed path, so it can never collide with `/api/posts/:id`: `trash` is not
 * a uuid, and the id route validates that before it touches the database.
 */
export const DELETE = handle(async () => {
  return json({ deleted: await emptyTrash(getDb()) });
});
