import { DriveImport } from "@/components/admin/DriveImport";

export const dynamic = "force-dynamic";

export default function AdminImportPage() {
  return (
    <main className="admin-main">
      <div className="admin-head">
        <h1 className="admin-title">Import from Drive</h1>
      </div>
      <p className="hint">
        Reads a Google Drive folder and everything under it, and files each
        document as a draft here. Google Docs, Markdown and plain text are
        imported; anything else is listed and passed over.
      </p>
      <DriveImport />
    </main>
  );
}
