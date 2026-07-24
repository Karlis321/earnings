import type { Metadata } from "next";
import { IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { PersistenceProvider } from "@/providers/PersistenceProvider";
import { SourceViewerProvider } from "@/providers/SourceViewerProvider";
import { ToastProvider } from "@/providers/ToastProvider";
import { AppShell } from "@/components/shell/AppShell";
import { SourceViewer } from "@/components/viewer/SourceViewer";

const ibmSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Earnings & Catalyst Dashboard",
  description:
    "Personal earnings tracking dashboard. Every number sourced, every event traceable.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={ibmSans.variable}>
      <body>
        <PersistenceProvider>
          <SourceViewerProvider>
            <ToastProvider>
              <AppShell>{children}</AppShell>
              <SourceViewer />
            </ToastProvider>
          </SourceViewerProvider>
        </PersistenceProvider>
      </body>
    </html>
  );
}
