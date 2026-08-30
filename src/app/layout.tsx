import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blog admin",
  description: "Phase 1 scaffold — post CRUD over the Neon-backed API.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
