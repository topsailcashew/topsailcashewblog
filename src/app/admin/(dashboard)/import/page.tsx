import { DropImport } from "@/components/admin/DropImport";

export const dynamic = "force-dynamic";

export default function AdminImportPage() {
  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Import</h1>
      </div>
      <p className="hint">
        Drop in Word documents, Markdown or text — one at a time, a whole
        folder, or a zip straight from Google Drive — and each becomes a draft
        here, formatting and all. Nothing is published; drafts wait for you in
        Articles.
      </p>
      <DropImport />
    </main>
  );
}
