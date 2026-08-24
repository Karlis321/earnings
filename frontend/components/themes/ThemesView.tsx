"use client";

// /themes render layer. Client component so we can hold the
// family-filter state locally. Renders three things stacked:
//   1. Family chip strip (All / Metals / Energy / Tech / …)
//   2. AI narrative theme cards (filtered by family, if any survive)
//   3. Mechanical sector grid (filtered by family)
// The page.tsx is just a server-side fetch shell that hands the
// two data objects down.

import { useMemo, useState } from "react";
import Link from "next/link";
import type {
  Sector,
  SectorHeadline,
  SectorIdeas,
  SectorSignals,
  SectorTheme,
} from "@/lib/types";
import {
  FAMILY_ORDER,
  familyOf,
  type SectorFamily,
} from "@/lib/sectorFamily";

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

function ThemeCard({ t }: { t: SectorTheme }) {
  return (
    <article className="flex flex-col rounded-[8px] border border-bd bg-panel2/60">
      <header className="border-b border-bd/40 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <Link
            href={`#sector-${t.sector}`}
            className="text-[13px] font-semibold capitalize tracking-[-0.01em] text-brand-fg hover:underline"
            title="Jump to the mechanical sector card below"
          >
            {fmtSector(t.sector)}
          </Link>
          <span
            className={`font-mono text-[11.5px] tabular-nums ${reactionClass(t.dataPoints.medianReaction3d)}`}
          >
            {fmtPct(t.dataPoints.medianReaction3d)}
          </span>
          <span className="ml-auto font-mono text-[9.5px] uppercase tracking-[0.07em] text-tx3">
            {t.dataPoints.tickerCount} tickers · {t.dataPoints.newsCountAll} news
          </span>
        </div>
        <p className="mt-2 text-[13.5px] leading-snug text-tx">{t.thesis}</p>
      </header>
      <div className="px-4 py-3">
        <p className="text-[12.5px] leading-relaxed text-tx-mid">
          {t.rationale}
        </p>
      </div>
      <div className="border-t border-bd/40 px-4 py-2">
        <div className="mono-eyebrow mb-1 text-tx3">§ Supporting tickers</div>
        <div className="flex flex-wrap gap-1.5">
          {t.supportingTickers.map((tk) => (
            <Link
              key={tk}
              href={`/s/${encodeURIComponent(tk)}`}
              className="rounded-[4px] border border-bd bg-panel2/60 px-1.5 py-[2px] font-mono text-[10.5px] text-brand-fg hover:border-brand/40 hover:text-brand"
            >
              {tk}
            </Link>
          ))}
        </div>
      </div>
      <div className="border-t border-bd/40 px-4 py-2">
        <div className="mono-eyebrow mb-1 text-tx3">
          § Cited headlines · {t.keyHeadlines.length}
        </div>
        <ul className="space-y-1">
          {t.keyHeadlines.map((h, i) => (
            <li
              key={`${h.ticker}-${i}`}
              className="flex items-baseline gap-2 text-[11.5px]"
            >
              <Link
                href={`/s/${encodeURIComponent(h.ticker)}`}
                className="shrink-0 font-mono text-[10.5px] text-brand-fg hover:underline"
              >
                {h.ticker}
              </Link>
              <span className="min-w-0 flex-1 truncate text-tx">
                {h.headline}
              </span>
              {h.source ? (
                <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.06em] text-tx3">
                  {h.source}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </article>
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
                {(m.hotSectorCount ?? 0) >= 2 ? (
                  <span
                    className="rounded-[3px] border border-brand/40 bg-brand/10 px-1 py-[1px] font-mono text-[9.5px] uppercase tracking-[0.06em] text-brand-fg"
                    title={`In ${m.hotSectorCount} hot sectors — cross-signal conviction`}
                  >
                    ×{m.hotSectorCount}
                  </span>
                ) : null}
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

function FamilyChips({
  active,
  setActive,
  countsByFamily,
}: {
  active: SectorFamily | "all";
  setActive: (f: SectorFamily | "all") => void;
  countsByFamily: Record<string, number>;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      {FAMILY_ORDER.map((f) => {
        const count = f.id === "all"
          ? Object.values(countsByFamily).reduce((s, n) => s + n, 0)
          : countsByFamily[f.id] ?? 0;
        if (f.id !== "all" && count === 0) return null;
        const isActive = active === f.id;
        return (
          <button
            key={f.id}
            onClick={() => setActive(f.id)}
            className={
              isActive
                ? "rounded-[6px] border border-brand bg-brand/10 px-2.5 py-1 text-[11.5px] font-medium text-brand-fg"
                : "rounded-[6px] border border-bd bg-panel2/60 px-2.5 py-1 text-[11.5px] text-tx-mid hover:border-brand/40 hover:text-brand-fg"
            }
          >
            {f.label}
            <span className="ml-1.5 font-mono text-[9.5px] text-tx3">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ThemesView({
  data,
  ideas,
}: {
  data: SectorSignals;
  ideas: SectorIdeas | null;
}) {
  const [family, setFamily] = useState<SectorFamily | "all">("all");

  const countsByFamily = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of data.sectors) {
      const fam = familyOf(s.sector);
      counts[fam] = (counts[fam] ?? 0) + 1;
    }
    return counts;
  }, [data.sectors]);

  const filteredSectors = useMemo(() => {
    if (family === "all") return data.sectors;
    return data.sectors.filter((s) => familyOf(s.sector) === family);
  }, [data.sectors, family]);

  const filteredThemes = useMemo(() => {
    if (!ideas) return null;
    if (family === "all") return ideas.themes;
    return ideas.themes.filter((t) => familyOf(t.sector) === family);
  }, [ideas, family]);

  return (
    <>
      <FamilyChips
        active={family}
        setActive={setFamily}
        countsByFamily={countsByFamily}
      />

      {ideas && filteredThemes && filteredThemes.length > 0 ? (
        <section className="mb-8" aria-label="AI-drafted sector themes">
          <div className="mb-3 flex items-baseline gap-3">
            <div className="mono-eyebrow text-tx3">§ Themes · AI narrative</div>
            <span className="font-mono text-[10.5px] text-tx3">
              {filteredThemes.length}
              {filteredThemes.length !== ideas.themes.length
                ? ` of ${ideas.themes.length}`
                : ""}{" "}
              themes · drafted {ideas.generatedAt.slice(0, 10)}
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {filteredThemes.map((t) => (
              <ThemeCard key={t.sector} t={t} />
            ))}
          </div>
          <p className="mt-3 max-w-[68ch] text-[11px] text-tx3">
            {ideas.disclaimer}
          </p>
        </section>
      ) : ideas && family !== "all" ? (
        <div className="mb-6 rounded-[8px] border border-dashed border-bd bg-panel2/40 px-4 py-3 text-[12px] text-tx-mid">
          No AI themes drafted for the{" "}
          <span className="text-tx">{family}</span> family this run.
        </div>
      ) : null}

      <div className="mb-3 flex items-baseline gap-3">
        <div className="mono-eyebrow text-tx3">§ Sector rollup</div>
        <span className="font-mono text-[10.5px] text-tx3">
          {filteredSectors.length}
          {filteredSectors.length !== data.sectors.length
            ? ` of ${data.sectors.length}`
            : ""}{" "}
          sectors · ranked by |median|
        </span>
      </div>

      {filteredSectors.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-bd bg-panel2/40 px-4 py-6 text-[13px] text-tx-mid">
          No sectors in the{" "}
          <span className="text-tx">{family}</span> family right now.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filteredSectors.map((s) => (
            <SectorCard key={s.sector} s={s} />
          ))}
        </div>
      )}
    </>
  );
}
