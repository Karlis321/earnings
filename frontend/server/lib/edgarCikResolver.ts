// Automatic ticker → SEC EDGAR CIK resolver.
//
// SEC publishes `company_tickers.json` — a public JSON that maps every US
// filer's ticker to its 10-digit CIK. Foreign private issuers that file
// 20-F/40-F also appear (often under a US-symbol variant, e.g. Abaxx
// Technologies → ABXXF).
//
// We fetch this file once per process (24h TTL) and match:
//   1. exact ticker (base symbol before the space)
//   2. if `US` suffix and no hit, try `<symbol>F` (foreign filer convention)
//   3. legal-name normalized fallback (strips Inc/Corp/Ltd/etc.)
//
// Returns the padded 10-digit CIK string, or `null` when the issuer is
// not an SEC filer.

const SEC_UA = "Earnings Tracker (contact@example.com)";
const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface SecTickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

let cache: {
  fetchedAt: number;
  byTicker: Map<string, SecTickerRow>;
  byNormalizedTitle: Map<string, SecTickerRow>;
} | null = null;

function pad10(cik: number | string): string {
  return String(cik).padStart(10, "0");
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(
      /\b(?:corporation|corp|incorporated|inc|company|co|limited|ltd|plc|s\.?a\.?|nv|ag|se|holdings?|group)\b/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

async function loadCache(): Promise<NonNullable<typeof cache>> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;
  const r = await fetch(SEC_TICKERS_URL, {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`sec company_tickers ${r.status}`);
  const raw = (await r.json()) as Record<string, SecTickerRow>;
  const byTicker = new Map<string, SecTickerRow>();
  const byNormalizedTitle = new Map<string, SecTickerRow>();
  for (const row of Object.values(raw)) {
    byTicker.set(row.ticker.toUpperCase(), row);
    byNormalizedTitle.set(normalizeName(row.title), row);
  }
  cache = { fetchedAt: now, byTicker, byNormalizedTitle };
  return cache;
}

export interface CikResolveInput {
  ticker: string;
  legalName?: string;
}

export async function resolveEdgarCik(
  input: CikResolveInput,
): Promise<string | null> {
  const c = await loadCache();
  const [rawSym, exch = "US"] = input.ticker.split(/\s+/);
  const sym = rawSym.toUpperCase();
  const isUs = exch.toUpperCase() === "US";
  const normalizedInput = input.legalName ? normalizeName(input.legalName) : "";

  // US-listed: base-symbol match is safe — the ticker uniquely identifies
  // the issuer on US exchanges.
  if (isUs) {
    const direct = c.byTicker.get(sym);
    if (direct) return pad10(direct.cik_str);
  } else {
    // Non-US: base-symbol match is UNSAFE (e.g. "RIO FP" is Amundi MSCI
    // Brazil ETF on Paris, not Rio Tinto). Require the legal name to
    // also match before accepting a direct-symbol hit. Fall through to
    // the F-variant + legal-name paths otherwise.
    const direct = c.byTicker.get(sym);
    if (direct && normalizedInput) {
      const secNorm = normalizeName(direct.title);
      if (secNorm && (secNorm === normalizedInput || secNorm.includes(normalizedInput) || normalizedInput.includes(secNorm))) {
        return pad10(direct.cik_str);
      }
    }
    // Foreign private issuers often list under a `<symbol>F` variant on OTC.
    const fVariant = c.byTicker.get(sym + "F");
    if (fVariant) return pad10(fVariant.cik_str);
  }

  if (normalizedInput) {
    const nameHit = c.byNormalizedTitle.get(normalizedInput);
    if (nameHit) return pad10(nameHit.cik_str);
  }
  return null;
}

export function edgarCacheStatus() {
  if (!cache) return { loaded: false as const };
  return {
    loaded: true as const,
    ageMs: Date.now() - cache.fetchedAt,
    entries: cache.byTicker.size,
  };
}
