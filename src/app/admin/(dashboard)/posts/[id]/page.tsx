import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { PostEditorLoader } from "@/components/admin/PostEditorLoader";
import { getPostById } from "@/lib/posts";
import { aiReady as isAiReady, loadAiSettings } from "@/lib/ai/config";
import { listSeries } from "@/lib/series";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

/**
 * `/admin/posts/new` renders an empty editor. The post row is not created
 * until the first save, so opening the page and closing it leaves no debris.
 */
export default async function EditorPage({ params }: { params: Params }) {
  const { id } = await params;

  const db = getDb();
  /*
    Resolved here rather than fetched by each panel: this component already
    awaits the series list, so readiness costs nothing extra — and knowing it
    before render means a *collapsed* panel header can say "no key", which is
    where you want to learn it, with no loading flicker on the way.
  */
  const [series, ai] = await Promise.all([
    listSeries(db).catch(() => []),
    loadAiSettings(db).catch(() => null),
  ]);
  const aiReady = ai ? isAiReady(ai) : false;

  if (id === "new") {
    return <PostEditorLoader initialPost={null} series={series} aiReady={aiReady} />;
  }

  if (!uuidSchema.safeParse(id).success) notFound();

  const post = await getPostById(db, id);
  if (!post) notFound();

  return <PostEditorLoader initialPost={post} series={series} aiReady={aiReady} />;
}
