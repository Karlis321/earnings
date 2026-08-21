import { Header } from "./Header";
import { Footer } from "./Footer";
import { Banners } from "./Banners";
import { store } from "@/server/store";

// Fresh-data timestamps for the three AI/data surfaces. Fetched
// once per request and handed to the client Header, which compares
// against localStorage watermarks to render a "new" dot next to
// the nav tab.
async function readFreshness(): Promise<{
  themes: string | null;
  weekAhead: string | null;
  screens: string | null;
}> {
  const [sectorSignals, narrative, blueOcean, ruleBreaker] = await Promise.all([
    store.readSectorSignals
      ? store.readSectorSignals()
      : Promise.resolve(null),
    store.readWeekAheadNarrative
      ? store.readWeekAheadNarrative()
      : Promise.resolve(null),
    store.readScreen ? store.readScreen("blue-ocean") : Promise.resolve(null),
    store.readScreen
      ? store.readScreen("rule-breaker")
      : Promise.resolve(null),
  ]);
  // Screens: max(blueOcean, ruleBreaker) — dot fires if EITHER
  // framework has new data.
  const screenTs = [blueOcean?.generatedAt, ruleBreaker?.generatedAt]
    .filter((t): t is string => !!t)
    .sort()
    .reverse()[0] ?? null;
  return {
    themes: sectorSignals?.generatedAt ?? null,
    weekAhead: narrative?.generatedAt ?? null,
    screens: screenTs,
  };
}

export async function AppShell({ children }: { children: React.ReactNode }) {
  const freshness = await readFreshness();
  return (
    <div className="flex min-h-screen flex-col bg-bg text-tx">
      <Header freshness={freshness} />
      <Banners />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
