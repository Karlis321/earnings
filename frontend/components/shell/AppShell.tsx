import { Header } from "./Header";
import { Footer } from "./Footer";
import { Banners } from "./Banners";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-tx">
      <Header />
      <Banners />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
