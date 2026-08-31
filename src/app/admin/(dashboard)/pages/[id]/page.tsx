import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { PageEditorLoader } from "@/components/admin/PageEditorLoader";
import { getPageById } from "@/lib/pages";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

/** `/admin/pages/new` opens an empty editor; the row appears on first save. */
export default async function PageEditorPage({ params }: { params: Params }) {
  const { id } = await params;
  if (id === "new") return <PageEditorLoader initialPage={null} />;

  if (!uuidSchema.safeParse(id).success) notFound();

  const page = await getPageById(getDb(), id);
  if (!page) notFound();

  return <PageEditorLoader initialPage={page} />;
}
