"use client";

import Link from "next/link";
import type { EtfDistribution, EtfHolding } from "@/lib/types";
import { fmtDate } from "@/lib/format";
import { TickerLogo } from "./TickerLogo";
import { ExternalLink, ChevronRight } from "lucide-react";

export function DistributionRow({ dist }: { dist: EtfDistribution }) {
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr] items-center gap-3 border-b border-bd px-4 py-3 last:border-b-0">
      <span className="font-mono text-[12.5px] text-tx tabular-nums">
        {fmtDate(dist.exDate)}
      </span>
      <span className="text-right font-mono text-[13.5px] font-semibold tabular-nums">
        {dist.amount.toFixed(2)} {dist.currency}
      </span>
      <span className="text-right font-mono text-[12.5px] text-tx-mid tabular-nums">
        {dist.yieldPct.toFixed(1)}%
      </span>
    </div>
  );
}

export function DistributionsTable({
  distributions,
}: {
  distributions: EtfDistribution[];
}) {
  if (!distributions.length) {
    return <div className="p-4 text-[13px] text-tx-mid">No distributions on file.</div>;
  }
  return (
    <div>
      <div className="grid grid-cols-[1fr_1fr_1fr] items-center gap-3 border-b border-bd bg-panel2 px-4 py-[10px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
        <span>Ex-date</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Yield</span>
      </div>
      {distributions.map((d) => (
        <DistributionRow key={d.exDate} dist={d} />
      ))}
    </div>
  );
}

// Holdings row — click walks to that ticker's security page when it's in
// coverage; otherwise opens the Yahoo Finance page in a new tab so the
// analyst always has a next step. Coverage set comes in via prop from the
// server RSC that owns the entity registry.
export function HoldingsTable({
  holdings,
  coveredTickers,
}: {
  holdings: EtfHolding[];
  coveredTickers?: Iterable<string>;
}) {
  if (!holdings.length) {
    return <div className="p-4 text-[13px] text-tx-mid">No holdings on file.</div>;
  }
  const covered = new Set(coveredTickers ?? []);
  return (
    <div>
      <div className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-3 border-b border-bd bg-panel2 px-4 py-[10px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-tx3">
        <span className="w-[30px]" />
        <span>Name · Ticker</span>
        <span className="text-right">Weight</span>
        <span className="w-4" />
      </div>
      {holdings.map((h) => {
        const inCoverage = covered.has(h.ticker);
        const yahooSymbol = toYahooSymbol(h.ticker);
        const Row = (
          <>
            <TickerLogo ticker={h.ticker} name={h.name} size={24} />
            <div className="flex flex-col">
              <span className="text-[13px] font-medium text-tx">{h.name}</span>
              <span className="font-mono text-[10.5px] text-tx-mid">
                {h.ticker}
                {inCoverage ? (
                  <span className="ml-2 rounded-[3px] bg-[rgba(18,183,106,0.10)] px-[5px] py-[1px] text-[9.5px] font-semibold uppercase tracking-[0.08em] text-success-fg">
                    covered
                  </span>
                ) : null}
              </span>
            </div>
            <span className="text-right font-mono text-[13px] font-semibold tabular-nums text-tx">
              {h.weight.toFixed(1)}%
            </span>
            <ChevronRight size={14} className="text-tx3" />
          </>
        );

        return inCoverage ? (
          <Link
            key={h.ticker}
            href={`/s/${encodeURIComponent(h.ticker)}`}
            className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-3 border-b border-bd px-4 py-[10px] last:border-b-0 transition-colors hover:bg-hover"
          >
            {Row}
          </Link>
        ) : (
          <a
            key={h.ticker}
            href={`https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-3 border-b border-bd px-4 py-[10px] last:border-b-0 transition-colors hover:bg-hover"
            title="Not in your coverage — open on Yahoo Finance"
          >
            <TickerLogo ticker={h.ticker} name={h.name} size={24} />
            <div className="flex flex-col">
              <span className="text-[13px] font-medium text-tx">{h.name}</span>
              <span className="font-mono text-[10.5px] text-tx-mid">
                {h.ticker}
                <span className="ml-2 text-tx3">↗ Yahoo</span>
              </span>
            </div>
            <span className="text-right font-mono text-[13px] font-semibold tabular-nums text-tx">
              {h.weight.toFixed(1)}%
            </span>
            <ExternalLink size={12} className="text-tx3" />
          </a>
        );
      })}
    </div>
  );
}

// Convert Bloomberg-style (e.g. "PAAS", "CS CN") to a Yahoo Finance URL symbol.
// Bare US tickers stay as-is; Canadian → append .TO, London → .L, etc.
function toYahooSymbol(bbTicker: string): string {
  const parts = bbTicker.split(/\s+/);
  const sym = parts[0];
  const suffix = parts[1] ?? "US";
  const map: Record<string, string> = {
    US: "",
    CN: ".TO",
    LN: ".L",
    FP: ".PA",
    GR: ".DE",
    BB: ".BR",
    NA: ".AS",
    IM: ".MI",
    SS: ".ST",
    NO: ".OL",
    SW: ".SW",
    BZ: ".SA",
    HK: ".HK",
    JP: ".T",
    AU: ".AX",
    FH: ".HE",
  };
  return sym + (map[suffix.toUpperCase()] ?? "");
}
