// FMP (Financial Modeling Prep) fallback for tickers where Yahoo's
// earningsChart/financialsChart return empty. Free tier is 250 req/day
// so we're careful: only called when `FMP_API_KEY` is set AND Yahoo
// returned no past quarters. Cron caches results per-ticker on
// entity.fundamentals.asOf so we don't re-hit FMP for names that
// already have data.
//
// Endpoints (v3 free-tier compatible):
//   /api/v3/income-statement/{symbol}?period=quarter&limit=5&apikey=...
//   /api/v3/earning_calendar/{symbol}?apikey=... (upcoming)
//
// Fails soft: any error path returns null so cron's null-guard falls
// back to Yahoo-only behavior.

export interface FmpQuarter {
  period: string; // "1Q2026" — matches Yahoo's earningsChart.date format
  fiscalDateEnding: string; // ISO "2026-03-31"
  revenue: number | null;
  netIncome: number | null;
  ebitda: number | null;
  operatingIncome: number | null;
  grossProfit: number | null;
  eps: number | null; // basic EPS reported
}

export interface FmpEarnings {
  yahooSymbol: string; // echoed for correlation
  fmpSymbol: string;
  nextEarningsDate: string | null; // ISO YYYY-MM-DD
  pastQuarters: FmpQuarter[];
}

function periodFromEndDate(endStr: string): string {
  const d = new Date(endStr);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${q}Q${y}`;
}

// Bloomberg-style "AAPL US" → FMP-usable "AAPL". "SAP.DE" → "SAP.DE"
// (FMP accepts the Yahoo-suffix form too for foreign listings).
function toFmpSymbol(yahooSymbol: string): string {
  return yahooSymbol;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function fmpEarnings(
  yahooSymbol: string,
): Promise<FmpEarnings | null> {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  const symbol = toFmpSymbol(yahooSymbol);

  // Income statement (last 5 quarters)
  const isUrl =
    `https://financialmodelingprep.com/api/v3/income-statement/${encodeURIComponent(symbol)}` +
    `?period=quarter&limit=5&apikey=${encodeURIComponent(key)}`;
  const rows = (await fetchJson(isUrl)) as
    | Array<{
        date?: string;
        revenue?: number | null;
        netIncome?: number | null;
        ebitda?: number | null;
        operatingIncome?: number | null;
        grossProfit?: number | null;
        eps?: number | null;
      }>
    | null;

  if (!rows || rows.length === 0) return null;

  const pastQuarters: FmpQuarter[] = rows
    .filter((r) => r.date)
    .map((r) => ({
      period: periodFromEndDate(r.date!),
      fiscalDateEnding: r.date!,
      revenue: r.revenue ?? null,
      netIncome: r.netIncome ?? null,
      ebitda: r.ebitda ?? null,
      operatingIncome: r.operatingIncome ?? null,
      grossProfit: r.grossProfit ?? null,
      eps: r.eps ?? null,
    }));

  // Upcoming earnings date (best effort — some plans return 403 here)
  const calUrl =
    `https://financialmodelingprep.com/api/v3/earning_calendar/${encodeURIComponent(symbol)}` +
    `?apikey=${encodeURIComponent(key)}`;
  const cal = (await fetchJson(calUrl)) as
    | Array<{ date?: string }>
    | null;
  let nextEarningsDate: string | null = null;
  if (cal && Array.isArray(cal)) {
    const nowIso = new Date().toISOString().slice(0, 10);
    const future = cal
      .map((c) => c.date)
      .filter((d): d is string => typeof d === "string" && d >= nowIso)
      .sort();
    if (future.length > 0) nextEarningsDate = future[0];
  }

  return {
    yahooSymbol,
    fmpSymbol: symbol,
    nextEarningsDate,
    pastQuarters,
  };
}
