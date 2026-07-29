#!/usr/bin/env node
/**
 * DEPRECATED (shard-first): reads + writes data/earnings.json (gitignored).
 * Shards are canonical. Kept for archival re-runs against a reconstituted
 * monolith.
 *
 * Backfill revenue actuals into existing past events. Reads
 * yahoo.earnings.financialsChart.quarterly (revenue + earnings per
 * quarter) and updates the revenue_*_m metric on any past event whose
 * period matches Yahoo's label ("1Q2026" etc.).
 *
 *   node scripts/backfill-revenue.mjs         # write
 *   node scripts/backfill-revenue.mjs --dry   # report only
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EARNINGS_PATH = path.join(ROOT, "data", "earnings.json");
const REGISTRY_PATH = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

let CRUMB = null;
let COOKIE_HEADER = "";
async function primeCrumb() {
  if (CRUMB) return CRUMB;
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "manual",
  });
  const setCookies =
    typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const raw of setCookies) {
    const f = raw.split(";", 1)[0].trim();
    const eq = f.indexOf("=");
    if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1));
  }
  COOKIE_HEADER = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE_HEADER) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: COOKIE_HEADER },
  });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

async function fetchQuarters(yahooSymbol) {
  await primeCrumb();
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}` +
    `?modules=earnings&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE_HEADER },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return j.quoteSummary?.result?.[0]?.earnings?.financialsChart?.quarterly ?? [];
  } catch {
    return [];
  }
}

function parseYahooPeriod(s) {
  const m = s.trim().match(/^(\d)Q(\d{4})$/);
  if (!m) return null;
  return { quarter: parseInt(m[1], 10), year: parseInt(m[2], 10) };
}
function parseStoredPeriod(s) {
  const m = s.trim().match(/^FY(\d{4})\s+Q(\d)$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), quarter: parseInt(m[2], 10) };
}

async function main() {
  console.log(`backfill-revenue · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf-8"));
  const snap = JSON.parse(await fs.readFile(EARNINGS_PATH, "utf-8"));
  const byTicker = new Map(reg.entities.map((e) => [e.ticker, e]));

  // Operating tickers with past events lacking revenue actual
  const operating = new Set(
    reg.entities
      .filter((e) => e.securityType === "operating" && e.yahooSymbol)
      .map((e) => e.ticker),
  );
  const candidates = new Set();
  for (const ev of snap.events) {
    if (!operating.has(ev.ticker)) continue;
    if (!ev.eventDate) continue;
    if (!parseStoredPeriod(ev.period)) continue;
    const rev = ev.metrics?.find((m) => /^revenue_[a-z]{3}_m$/.test(m.key));
    if (rev && (rev.actual == null || rev.actual.value == null)) {
      candidates.add(ev.ticker);
    }
  }

  console.log(`Candidates to fetch: ${candidates.size} tickers`);
  const perTicker = new Map();
  let idx = 0;
  for (const ticker of candidates) {
    idx++;
    const entity = byTicker.get(ticker);
    if (!entity?.yahooSymbol) continue;
    const quarters = await fetchQuarters(entity.yahooSymbol);
    // Index by parsed period
    const byPeriod = new Map();
    for (const q of quarters) {
      if (!q.date) continue;
      const parsed = parseYahooPeriod(q.date);
      if (!parsed) continue;
      byPeriod.set(`${parsed.year}-Q${parsed.quarter}`, {
        revenue: q.revenue?.raw ?? null,
      });
    }
    perTicker.set(ticker, byPeriod);
    if (idx <= 5 || idx % 20 === 0) {
      console.log(`  [${idx}/${candidates.size}] ${ticker} → ${byPeriod.size} quarters from Yahoo`);
    }
  }

  const now = new Date().toISOString();
  const asOf = now.slice(0, 10);
  let updated = 0;
  const perTickerUpdates = new Map();
  for (const ev of snap.events) {
    const parsed = parseStoredPeriod(ev.period);
    if (!parsed) continue;
    const byPeriod = perTicker.get(ev.ticker);
    if (!byPeriod) continue;
    const hit = byPeriod.get(`${parsed.year}-Q${parsed.quarter}`);
    if (!hit || hit.revenue == null) continue;
    const revM = hit.revenue / 1_000_000;
    for (const m of ev.metrics ?? []) {
      if (!/^revenue_[a-z]{3}_m$/.test(m.key)) continue;
      if (m.actual && m.actual.value != null) continue;
      const entity = byTicker.get(ev.ticker);
      const sym = entity?.yahooSymbol ?? "";
      m.actual = {
        value: revM,
        unit: m.key.split("_")[1]?.toUpperCase() ?? "USD",
        source: {
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/financials`,
          label: "Yahoo Finance · financials",
          provenance: "wire",
          locator: null,
        },
        asOf,
        fetchedAt: now,
        method: "yahoo",
        confidence: 0.85,
      };
      // Compute surprisePct if estimate exists
      if (m.estimate && m.estimate.value != null && Math.abs(m.estimate.value) > 1e-9) {
        m.surprisePct = ((revM - m.estimate.value) / Math.abs(m.estimate.value)) * 100;
      }
      updated++;
      perTickerUpdates.set(ev.ticker, (perTickerUpdates.get(ev.ticker) ?? 0) + 1);
    }
  }

  console.log(`\nRevenue actuals filled in: ${updated}`);
  for (const [t, n] of [...perTickerUpdates.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(12)} +${n}`);
  }

  if (DRY) {
    console.log("Dry run — no write.");
    return;
  }
  await fs.writeFile(EARNINGS_PATH, JSON.stringify(snap, null, 2));
  console.log(`\n✓ wrote ${EARNINGS_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
