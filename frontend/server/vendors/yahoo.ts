// Yahoo Finance — server-side wrappers.
// Ported from backend/reference/ticker-lookup.js and news.txt.txt.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const YAHOO_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

/* -------- symbol resolution (query2 search) -------- */

// Bloomberg exchange suffix → set of acceptable Yahoo `exchange` codes.
export const EXCHANGE_MAP: Record<string, string[]> = {
  US: ["NMS", "NYQ", "ASE", "NGM", "NCM", "PCX", "NYS", "OEM", "OQX", "BTS"],
  CN: ["TOR", "VAN", "CVE", "NEO", "CDNX", "CDX", "CNX"],
  LN: ["LSE"],
  GR: ["GER", "FRA", "BER", "DUS", "HAM", "MUN", "STU"],
  FP: ["PAR"],
  BB: ["EBR"],
  NA: ["AMS"],
  IM: ["MIL"],
  SM: ["MCE"],
  SS: ["STO"],
  NO: ["OSL"],
  DC: ["CSE"],
  SW: ["SWX", "EBS", "VTX"],
  AV: ["VIE"],
  BZ: ["SAO"],
  MM: ["MEX"],
  AU: ["ASX"],
  HK: ["HKG"],
  JP: ["TYO", "JPX", "OSE"],
  KS: ["KSC"],
  IN: ["NSI", "BOM"],
  SP: ["SES"],
  FH: ["HEL"],
};

export interface YahooLookupResult {
  symbol: string;
  exchange: string;
  name: string;
  yahooSymbol: string;
  yahooExchange: string | null;
  exchDisp: string | null;
  sector: string | null;
  industry: string | null;
  onRequestedExchange: boolean;
}

interface YahooQuote {
  quoteType?: string;
  symbol?: string;
  exchange?: string;
  exchDisp?: string;
  longname?: string;
  shortname?: string;
  sector?: string;
  industry?: string;
}

export async function yahooLookup(
  rawSymbol: string,
  exchange: string,
): Promise<YahooLookupResult | { error: string; status: number }> {
  const symbol = rawSymbol.trim().toUpperCase();
  const isIndex = exchange === "Index";
  const acceptable = isIndex ? null : EXCHANGE_MAP[exchange.toUpperCase()];
  if (!isIndex && !acceptable) {
    return { error: `Unknown exchange code: ${exchange}`, status: 400 };
  }

  const buildUrl = (q: string) =>
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}` +
    `&quotesCount=10&newsCount=0`;

  const fetchYahoo = async (
    q: string,
  ): Promise<{ ok: boolean; status: number; quotes: YahooQuote[] }> => {
    try {
      const r = await fetch(buildUrl(q), { headers: YAHOO_HEADERS });
      if (!r.ok) return { ok: false, status: r.status, quotes: [] };
      const data = (await r.json()) as { quotes?: YahooQuote[] };
      return { ok: true, status: 200, quotes: data.quotes ?? [] };
    } catch {
      return { ok: false, status: 599, quotes: [] };
    }
  };

  const first = await fetchYahoo(symbol);
  if (!first.ok) return { error: `Yahoo ${first.status}`, status: 502 };
  let quotes = first.quotes;

  if (isIndex) {
    let match =
      quotes.find(
        (q) =>
          q.quoteType === "INDEX" &&
          (q.symbol === symbol || q.symbol === "^" + symbol),
      ) ?? quotes.find((q) => q.quoteType === "INDEX");
    if (!match) {
      const second = await fetchYahoo("^" + symbol);
      if (second.ok) quotes = second.quotes;
      match =
        quotes.find(
          (q) =>
            q.quoteType === "INDEX" &&
            (q.symbol === "^" + symbol || q.symbol === symbol),
        ) ?? quotes.find((q) => q.quoteType === "INDEX");
    }
    if (!match) return { error: `No index for ${symbol}`, status: 404 };
    return {
      symbol,
      exchange: "Index",
      name: match.longname ?? match.shortname ?? symbol,
      yahooSymbol: match.symbol ?? symbol,
      yahooExchange: match.exchange ?? null,
      exchDisp: match.exchDisp ?? null,
      sector: "Index",
      industry: match.exchDisp ?? "Equity index",
      onRequestedExchange: true,
    };
  }

  const onExchange = quotes.find(
    (q) =>
      q.quoteType === "EQUITY" &&
      typeof q.exchange === "string" &&
      acceptable!.includes(q.exchange) &&
      (q.symbol === symbol || q.symbol?.split(".")[0] === symbol),
  );
  const anyEquity =
    onExchange ??
    quotes.find(
      (q) =>
        q.quoteType === "EQUITY" &&
        (q.symbol === symbol || q.symbol?.startsWith(symbol + ".")),
    );

  if (!anyEquity)
    return { error: `No equity ${symbol} on ${exchange}`, status: 404 };
  return {
    symbol,
    exchange,
    name: anyEquity.longname ?? anyEquity.shortname ?? symbol,
    yahooSymbol: anyEquity.symbol ?? symbol,
    yahooExchange: anyEquity.exchange ?? null,
    exchDisp: anyEquity.exchDisp ?? null,
    sector: anyEquity.sector ?? null,
    industry: anyEquity.industry ?? null,
    onRequestedExchange: onExchange !== undefined,
  };
}

/* -------- chart / price series (v8 chart endpoint) -------- */

export interface YahooQuoteSample {
  symbol: string;
  label: string;
  unit: string;
  value: number;
  prev: number;
  change: number;
  pctChange: number;
  date: string;
  currency: string;
}

export async function yahooQuote(
  symbol: string,
  label: string,
  unit = "",
  range = "5d",
  interval = "1d",
): Promise<YahooQuoteSample | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}`;
  try {
    const r = await fetch(url, { headers: YAHOO_HEADERS });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      chart?: { result?: Array<{
        meta?: { regularMarketTime?: number; currency?: string };
        indicators?: { quote?: Array<{ close?: (number | null)[] }> };
      }> };
    };
    const result = j.chart?.result?.[0];
    if (!result) return null;
    const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
      (v): v is number => typeof v === "number",
    );
    if (closes.length < 1) return null;
    const latest = closes[closes.length - 1];
    const prev = closes.length >= 2 ? closes[closes.length - 2] : latest;
    return {
      symbol,
      label,
      unit,
      value: latest,
      prev,
      change: latest - prev,
      pctChange: prev ? ((latest - prev) / prev) * 100 : 0,
      date: new Date((result.meta?.regularMarketTime ?? 0) * 1000)
        .toISOString()
        .slice(0, 10),
      currency: result.meta?.currency ?? "",
    };
  } catch {
    return null;
  }
}

// Full daily series for chart rendering.
export async function yahooSeries(
  symbol: string,
  range = "1y",
  interval = "1d",
): Promise<{ date: string; close: number }[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}`;
  try {
    const r = await fetch(url, { headers: YAHOO_HEADERS });
    if (!r.ok) return [];
    const j = (await r.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
      };
    };
    const result = j.chart?.result?.[0];
    if (!result) return [];
    const ts = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const out: { date: string; close: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === "number") {
        out.push({
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          close: c,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
