import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { RoleProvider } from "@/providers/RoleProvider";
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
const ibmMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Signal · BluOr Earnings & Catalyst Dashboard",
  description:
    "Internal BluOr AM tool. Every number sourced, every event traceable.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" className={`${ibmSans.variable} ${ibmMono.variable}`}>
      <body>
        <ThemeProvider>
          <RoleProvider>
            <PersistenceProvider>
              <SourceViewerProvider>
                <ToastProvider>
                  <AppShell>{children}</AppShell>
                  <SourceViewer />
                </ToastProvider>
              </SourceViewerProvider>
            </PersistenceProvider>
          </RoleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
