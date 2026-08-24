import Link from "next/link";
import type { SectorIdeas, SectorTheme } from "@/lib/types";

// LLM-drafted sector themes above the mechanical sector grid on
// /themes. Renders 5-8 cards, each with thesis, rationale,
// supporting-ticker chips, and cited headlines. Every claim is
// cross-checked against sector-signals.json at apply time — the
// component just displays what's on disk.

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

function ThemeCard({ t }: { t: SectorTheme }) {
  return (
    <article className="flex flex-col rounded-[8px] border border-bd bg-panel2/60">
      <header className="border-b border-bd/40 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <Link
            href={`/themes#sector-${t.sector}`}
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

export function ThemesPanel({ ideas }: { ideas: SectorIdeas }) {
  if (!ideas.themes || ideas.themes.length === 0) return null;
  return (
    <section className="mb-8" aria-label="AI-drafted sector themes">
      <div className="mb-3 flex items-baseline gap-3">
        <div className="mono-eyebrow text-tx3">§ Themes · AI narrative</div>
        <span className="font-mono text-[10.5px] text-tx3">
          {ideas.themes.length} themes · drafted{" "}
          {ideas.generatedAt.slice(0, 10)}
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {ideas.themes.map((t) => (
          <ThemeCard key={t.sector} t={t} />
        ))}
      </div>
      <p className="mt-3 max-w-[68ch] text-[11px] text-tx3">
        {ideas.disclaimer}
      </p>
    </section>
  );
}
