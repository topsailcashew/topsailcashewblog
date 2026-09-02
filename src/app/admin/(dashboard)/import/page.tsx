import { DropImport } from "@/components/admin/DropImport";

export const dynamic = "force-dynamic";

export default function AdminImportPage() {
  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Import</h1>
      </div>
      <p className="hint">
        Drop in Markdown or text files — one at a time, or a whole folder with
        subfolders — and each becomes a draft here. Nothing is published;
        drafts wait for you in Articles.
      </p>
      <DropImport />
    </main>
  );
}
