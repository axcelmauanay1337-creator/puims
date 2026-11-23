import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PUIMS — Pulmonary Unit", template: "%s · PUIMS" },
  description: "Pulmonary Unit Information and Management System for Respiratory Therapists.",
  applicationName: "PUIMS",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "PUIMS", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#f7f7f4",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Reading request headers makes EVERY page dynamic, so each response gets the
  // per-request CSP nonce set in src/proxy.ts (static HTML cannot carry one).
  await headers();
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
