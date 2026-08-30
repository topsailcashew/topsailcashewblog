/**
 * Shared by every public route. Deliberately thin: the black-canvas framing is
 * a homepage signature (Design.md §3), so the chrome lives one level down —
 * in `(reading)/layout.tsx` for reading pages, and in the homepage itself.
 */
export default function PublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      {children}
    </>
  );
}
