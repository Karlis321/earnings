import Link from "next/link";
import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import type { Sector, SectorHeadline } from "@/lib/types";

// /themes — sector-level rollup replacing the per-ticker Ideas
// leaderboard. Every card shows a sector's median reaction,
// ticker count, top movers, and recent headlines. Mechanical —
// no LLM in this slice; that's a follow-up if the rollup surfaces
// enough signal.

export const dynamic = "force-dynamic";

function fmtPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function reactionClass(v: number | null): string {
  if (v === null) return "text-tx3";
  if (v > 1) return "text-success-fg";
  if (v < -1) return "text-danger";
  return "text-tx-mid";
}

function fmtSector(s: string): string {
  return s.replace(/-/g, " ");
}

function HeadlineRow({ h }: { h: SectorHeadline }) {
  const dateOnly = (h.time ?? "").slice(0, 10);
  return (
    <li className="border-b border-bd/40 py-1.5 last:border-b-0">
      <div className="flex items-baseline gap-2 text-[12px]">
        <Link
          href={`/s/${encodeURIComponent(h.ticker)}`}
          className="shrink-0 font-mono text-[11px] text-brand-fg hover:underline"
        >
          {h.ticker}
        </Link>
        {h.url ? (
          <a
            href={h.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate text-tx hover:text-brand-fg hover:underline"
          >
            {h.headline}
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate text-tx">
            {h.headline}
          </span>
        )}
        <span className="shrink-0 font-mono text-[9.5px] text-tx3">
          {dateOnly}
        </span>
      </div>
      {h.source ? (
        <div className="mt-0.5 pl-[3.4rem] font-mono text-[9.5px] uppercase tracking-[0.06em] text-tx3">
          {h.source}
        </div>
      ) : null}
    </li>
  );
}

function SectorCard({ s }: { s: Sector }) {
  return (
    <section
      id={`sector-${s.sector}`}
      className="scroll-mt-24 rounded-[8px] border border-bd bg-panel"
    >
      <header className="border-b border-bd px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[16px] font-semibold capitalize tracking-[-0.01em] text-tx">
            {fmtSector(s.sector)}
          </h2>
          <span
            className={`font-mono text-[13px] tabular-nums ${reactionClass(s.medianReaction3d)}`}
            title="Median 3-day post-earnings excess return across the sector's tickers"
          >
            {fmtPct(s.medianReaction3d)}
          </span>
          <span className="ml-auto font-mono text-[10.5px] text-tx3">
            {s.tickerCount} tickers · {s.newsCountAll} news items
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10.5px] text-tx-mid">
          <span>
            median surprise:{" "}
            <span className="tabular-nums text-tx">
              {fmtPct(s.medianSurprise)}
            </span>
          </span>
        </div>
      </header>

      {s.topMovers.length > 0 ? (
        <div className="border-b border-bd px-4 py-2">
          <div className="mono-eyebrow mb-1 text-tx3">§ Top movers</div>
          <div className="space-y-0.5 text-[12px]">
            {s.topMovers.map((m) => (
              <div key={m.ticker} className="flex items-baseline gap-2">
                <Link
                  href={`/s/${encodeURIComponent(m.ticker)}`}
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  <span className="font-mono text-brand-fg">{m.ticker}</span>
                  <span className="ml-1.5 text-tx-mid">{m.displayName}</span>
                </Link>
                <span
                  className={`ml-auto font-mono text-[11.5px] tabular-nums ${reactionClass(m.reaction3d)}`}
                >
                  {fmtPct(m.reaction3d)}
                </span>
                {m.lastPeriod ? (
                  <span className="shrink-0 font-mono text-[10px] text-tx3">
                    {m.lastPeriod}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {s.recentHeadlines.length > 0 ? (
        <div className="px-4 py-2">
          <div className="mono-eyebrow mb-1 text-tx3">
            § Recent news · {s.recentHeadlines.length} items
          </div>
          <ul className="max-h-[240px] overflow-y-auto">
            {s.recentHeadlines.map((h, i) => (
              <HeadlineRow key={`${h.ticker}-${i}`} h={h} />
            ))}
          </ul>
        </div>
      ) : (
        <div className="px-4 py-3 text-[12px] text-tx3">
          No headlines within the news window.
        </div>
      )}
    </section>
  );
}

export default async function ThemesPage() {
  const data = store.readSectorSignals
    ? await store.readSectorSignals()
    : null;

  if (!data) {
    return (
      <div className="mx-auto max-w-[1200px] px-10 py-20">
        <EmptyState
          title="No sector rollup yet"
          hint="Run scripts/aggregate-by-sector.mjs to populate data/sector-signals.json. Mechanical (no LLM, no vendor calls) — takes ~1 min."
        />
      </div>
    );
  }

  const generatedDate = data.generatedAt.slice(0, 10);
  return (
    <div className="mx-auto max-w-[1400px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Themes · Sector rollup</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {data.sectors.length} sectors ranked by |median reaction|
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13px] text-tx-mid">
          Each ticker in the tracked universe contributes to every
          sector tag it carries. Median reaction is the 3-day
          post-earnings excess return; recent news pulled from the
          top movers within the last {data.newsWindowDays} days.
          Sectors with fewer than {data.minTickersPerSector} tickers
          drop off. Last refresh: {generatedDate}.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {data.sectors.map((s) => (
          <SectorCard key={s.sector} s={s} />
        ))}
      </div>
    </div>
  );
}
