import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { PostEditorLoader } from "@/components/admin/PostEditorLoader";
import { getPostById } from "@/lib/posts";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

/**
 * `/admin/posts/new` renders an empty editor. The post row is not created
 * until the first save, so opening the page and closing it leaves no debris.
 */
export default async function EditorPage({ params }: { params: Params }) {
  const { id } = await params;

  if (id === "new") {
    return <PostEditorLoader initialPost={null} />;
  }

  if (!uuidSchema.safeParse(id).success) notFound();

  const post = await getPostById(getDb(), id);
  if (!post) notFound();

  return <PostEditorLoader initialPost={post} />;
}
