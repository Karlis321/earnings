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

// ---------- Crumb + cookie handshake ----------
//
// As of 2024–2025 Yahoo requires a `crumb` query parameter + matching
// A1/A3/B session cookies on quoteSummary and a few other endpoints.
// Handshake:
//   1. GET https://finance.yahoo.com/  → picks up A1/A3/B in Set-Cookie
//   2. GET https://query2.finance.yahoo.com/v1/test/getcrumb
//      (send the cookies from step 1) → response body is the crumb string
// We cache the pair in-process for 55 minutes; on any 401 we clear the
// cache and re-handshake once.

interface CrumbState {
  crumb: string;
  cookieHeader: string;
  expiresAt: number;
}
let crumbState: CrumbState | null = null;
const CRUMB_TTL_MS = 55 * 60 * 1000;

function parseCookieNamesFromSetCookie(setCookies: string[]): string {
  const pairs = new Map<string, string>();
  for (const raw of setCookies) {
    // Only take the first "name=value" segment; drop attributes (Path, Expires, …).
    const firstPart = raw.split(";", 1)[0]?.trim();
    if (!firstPart) continue;
    const eq = firstPart.indexOf("=");
    if (eq < 0) continue;
    const name = firstPart.slice(0, eq).trim();
    const value = firstPart.slice(eq + 1).trim();
    if (!name || !value) continue;
    pairs.set(name, value);
  }
  return Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
}

async function fetchCrumb(): Promise<CrumbState | null> {
  try {
    // Step 1 — prime the A3 session cookie. fc.yahoo.com is the canonical
    // seeding endpoint (returns a 404 body but sets A3 in Set-Cookie).
    // finance.yahoo.com itself redirects into the GDPR consent flow when
    // we let fetch follow redirects, and never seeds A3 directly.
    const r1 = await fetch("https://fc.yahoo.com/", {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual",
    });
    // Node 20+ standardizes getSetCookie(); fall back to raw()/get() if not.
    let setCookies: string[] = [];
    const hdrs = r1.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof hdrs.getSetCookie === "function") {
      setCookies = hdrs.getSetCookie();
    } else {
      const raw = r1.headers.get("set-cookie");
      if (raw) setCookies = [raw];
    }
    const cookieHeader = parseCookieNamesFromSetCookie(setCookies);
    if (!cookieHeader) return null;

    // Step 2 — fetch the crumb using those cookies.
    const r2 = await fetch(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      {
        headers: {
          "User-Agent": UA,
          Accept: "text/plain",
          Cookie: cookieHeader,
        },
      },
    );
    if (!r2.ok) return null;
    const crumb = (await r2.text()).trim();
    if (!crumb || /Unauthorized|<html/i.test(crumb)) return null;

    return {
      crumb,
      cookieHeader,
      expiresAt: Date.now() + CRUMB_TTL_MS,
    };
  } catch {
    return null;
  }
}

async function getCrumb(force = false): Promise<CrumbState | null> {
  if (!force && crumbState && crumbState.expiresAt > Date.now()) {
    return crumbState;
  }
  crumbState = await fetchCrumb();
  return crumbState;
}

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

/* -------- earnings & calendar (quoteSummary) -------- */

export interface YahooEarnings {
  yahooSymbol: string;
  nextEarningsDate: string | null; // ISO date if known
  lastQuarter: {
    period: string;
    actual: number | null;
    estimate: number | null;
    surprisePct: number | null;
  } | null;
  currentQuarterEstimate: number | null;
}

interface YahooRaw {
  raw?: number;
  fmt?: string;
}

interface QuoteSummaryResponse {
  quoteSummary?: {
    result?: Array<{
      calendarEvents?: {
        earnings?: {
          earningsDate?: YahooRaw[];
        };
      };
      earnings?: {
        earningsChart?: {
          quarterly?: Array<{
            date?: string;
            actual?: YahooRaw;
            estimate?: YahooRaw;
          }>;
          currentQuarterEstimate?: YahooRaw;
        };
      };
    }>;
  };
}

async function fetchQuoteSummary(
  yahooSymbol: string,
): Promise<QuoteSummaryResponse | null> {
  // v10 quoteSummary requires the crumb + cookie handshake since 2024.
  // We handshake once, cache for ~55 min, and retry once on 401.
  const baseUrl =
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}` +
    `?modules=earnings,calendarEvents&formatted=true`;

  const attempt = async (state: CrumbState): Promise<Response> => {
    const url = `${baseUrl}&crumb=${encodeURIComponent(state.crumb)}`;
    return fetch(url, {
      headers: {
        ...YAHOO_HEADERS,
        Cookie: state.cookieHeader,
      },
    });
  };

  let state = await getCrumb();
  if (!state) return null;
  let r = await attempt(state);
  if (r.status === 401) {
    state = await getCrumb(true);
    if (!state) return null;
    r = await attempt(state);
  }
  if (!r.ok) return null;
  try {
    return (await r.json()) as QuoteSummaryResponse;
  } catch {
    return null;
  }
}

export async function yahooEarnings(
  yahooSymbol: string,
): Promise<YahooEarnings | null> {
  // v10 quoteSummary. modules=earnings,calendarEvents gives us next-earnings
  // date + trailing quarters + current-quarter estimate.
  try {
    const j = await fetchQuoteSummary(yahooSymbol);
    if (!j) return null;
    const result = j.quoteSummary?.result?.[0];
    if (!result) return null;

    // Next earnings date — Yahoo returns an array (usually 1 entry, sometimes
    // a range of two). Take the earliest future one.
    let nextEarningsDate: string | null = null;
    const dates = result.calendarEvents?.earnings?.earningsDate ?? [];
    for (const d of dates) {
      if (typeof d.raw === "number") {
        const iso = new Date(d.raw * 1000).toISOString().slice(0, 10);
        if (!nextEarningsDate || iso < nextEarningsDate) nextEarningsDate = iso;
      }
    }

    // Last-quarter actual + estimate (surprise pct if both present).
    const quarterly = result.earnings?.earningsChart?.quarterly ?? [];
    const last = quarterly[quarterly.length - 1];
    let lastQuarter: YahooEarnings["lastQuarter"] = null;
    if (last) {
      const actual = last.actual?.raw ?? null;
      const estimate = last.estimate?.raw ?? null;
      const surprisePct =
        actual !== null && estimate !== null && Math.abs(estimate) > 0.0001
          ? ((actual - estimate) / Math.abs(estimate)) * 100
          : null;
      lastQuarter = {
        period: last.date ?? "",
        actual,
        estimate,
        surprisePct,
      };
    }

    return {
      yahooSymbol,
      nextEarningsDate,
      lastQuarter,
      currentQuarterEstimate:
        result.earnings?.earningsChart?.currentQuarterEstimate?.raw ?? null,
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
