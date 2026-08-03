#!/usr/bin/env node
/**
 * Standalone market-cap batch refresh. Ports the cron-only path from
 * frontend/app/api/cron/daily/route.ts (step 6b — market-cap resolve).
 *
 * Why standalone: the cron path is inside a Vercel 300s function
 * budget and requires POST auth. When GitHub Actions minutes are
 * available we prefer to run this out-of-Vercel via the
 * refresh-universe orchestrator, so market-cap freshness isn't
 * gated on the same rate-limited PAT that the /s/[ticker] route
 * pulls the store from.
 *
 * Behavior:
 *   - Reads entity-registry from disk (no network for the registry).
 *   - Groups every entity with a persisted yahooSymbol into batches
 *     of ≤100 symbols per Yahoo v7 `/quote` call.
 *   - Performs the same crumb + cookie handshake as the TS wrapper.
 *   - Converts marketCap → USD via live Yahoo `<CCY>USD=X` rates
 *     (falls back to a hardcoded 2026-mid table on transient 401).
 *   - Writes back to data/entity-registry.json ONLY entities whose
 *     marketCapUsd, capTier, or marketCapAsOf actually changed.
 *   - Rate limit: single ~100-symbol call every 500ms — Yahoo v7
 *     tolerates this comfortably.
 *   - Per-request timeout: 8s (matches CLAUDE.md batch-script rule).
 *   - Concurrency: 1 (batches are sequential; the "concurrency" in
 *     the CLAUDE.md rule refers to per-request parallelism inside
 *     a phase, not batch-to-batch here).
 *
 * CLI:
 *   node scripts/refresh-marketcap.mjs               # write
 *   node scripts/refresh-marketcap.mjs --dry-run     # report only
 *   node scripts/refresh-marketcap.mjs --limit=200   # small probe
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT, "data", "entity-registry.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? 0) || null;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const YAHOO_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

const FX_FALLBACK = {
  USD: 1, EUR: 1.14, GBP: 1.33, JPY: 0.0067, CHF: 1.12, CAD: 0.71,
  AUD: 0.70, NZD: 0.58, SEK: 0.096, NOK: 0.093, DKK: 0.144, ISK: 0.008,
  PLN: 0.26, CZK: 0.047, HUF: 0.0032, RON: 0.22, TRY: 0.021, HKD: 0.128,
  SGD: 0.75, CNY: 0.148, KRW: 0.00068, TWD: 0.031, INR: 0.012, IDR: 0.000056,
  THB: 0.030, MYR: 0.245, PHP: 0.016, ILS: 0.33, AED: 0.272, SAR: 0.266,
  QAR: 0.275, ZAR: 0.060, BRL: 0.197, MXN: 0.055, CLP: 0.00105, COP: 0.00031,
  PEN: 0.295, ARS: 0.00067,
};

function capTierFor(cap) {
  if (cap == null || Number.isNaN(cap)) return "unknown";
  if (cap >= 200e9) return "mega";
  if (cap >= 10e9) return "large";
  if (cap >= 2e9) return "mid";
  if (cap >= 250e6) return "small";
  return "unknown";
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function parseCookieNames(setCookies) {
  const pairs = new Map();
  for (const raw of setCookies) {
    const firstPart = raw.split(";", 1)[0]?.trim();
    if (!firstPart) continue;
    const eq = firstPart.indexOf("=");
    if (eq < 0) continue;
    pairs.set(firstPart.slice(0, eq).trim(), firstPart.slice(eq + 1).trim());
  }
  return [...pairs].map(([n, v]) => `${n}=${v}`).join("; ");
}

const CRUMB_CACHE = "/tmp/yahoo-crumb.json";
async function getCrumb() {
  // Try the shared cache first — see scripts/prime-yahoo-crumb.mjs
  // for the writer. Cache is valid for 55 min from the first prime
  // in the orchestrator run. Falls through to a fresh prime + retry
  // if the file is missing or the crumb has expired.
  try {
    const raw = await fs.readFile(CRUMB_CACHE, "utf-8");
    const cached = JSON.parse(raw);
    if (cached.crumb && cached.cookie && cached.expiresAt > Date.now()) {
      return { crumb: cached.crumb, cookieHeader: cached.cookie };
    }
  } catch { /* no cache — fresh prime below */ }
  // 3-attempt retry — see mature-any-reported.mjs primeCrumb for
  // rationale (intermittent Yahoo response from datacenter IPs).
  for (let attempt = 1; attempt <= 3; attempt++) {
    const state = await tryGetCrumb();
    if (state) {
      // Populate cache for the rest of the orchestrator run.
      try {
        await fs.writeFile(CRUMB_CACHE, JSON.stringify({
          crumb: state.crumb,
          cookie: state.cookieHeader,
          expiresAt: Date.now() + 55 * 60_000,
        }));
      } catch { /* best-effort */ }
      return state;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
async function tryGetCrumb() {
  try {
  const r1 = await fetchWithTimeout("https://fc.yahoo.com/", {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "manual",
  });
  const hdrs = r1.headers;
  const setCookies = typeof hdrs.getSetCookie === "function"
    ? hdrs.getSetCookie()
    : (hdrs.get("set-cookie") ? [hdrs.get("set-cookie")] : []);
  const cookieHeader = parseCookieNames(setCookies);
  if (!cookieHeader) return null;
  const r2 = await fetchWithTimeout(
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
  return { crumb, cookieHeader };
  } catch { return null; }
}

async function fetchQuotesRaw(symbols, state) {
  if (symbols.length === 0) return [];
  const url =
    `https://query1.finance.yahoo.com/v7/finance/quote` +
    `?symbols=${encodeURIComponent(symbols.join(","))}` +
    `&crumb=${encodeURIComponent(state.crumb)}`;
  const r = await fetchWithTimeout(url, {
    headers: { ...YAHOO_HEADERS, Cookie: state.cookieHeader },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.quoteResponse?.result ?? []).map((row) => ({
    yahooSymbol: row.symbol ?? "",
    currency: row.currency ?? "USD",
    marketCap: row.marketCap ?? row.netAssets ?? row.totalAssets ?? null,
    regularMarketPrice: row.regularMarketPrice ?? null,
  }));
}

async function fetchFxRates(state) {
  const symbols = Object.keys(FX_FALLBACK).filter((c) => c !== "USD").map((c) => `${c}USD=X`);
  const rates = { USD: 1 };
  try {
    const rows = await fetchQuotesRaw(symbols, state);
    for (const row of rows) {
      const ccy = row.yahooSymbol.replace(/USD=X$/, "");
      if (typeof row.regularMarketPrice === "number" && row.regularMarketPrice > 0) {
        rates[ccy] = row.regularMarketPrice;
      }
    }
  } catch { /* fall through */ }
  for (const [ccy, fb] of Object.entries(FX_FALLBACK)) {
    if (rates[ccy] == null) rates[ccy] = fb;
  }
  return rates;
}

function toUsd(amount, currency, rates) {
  if (amount == null) return null;
  return Math.round(amount * (rates[currency] ?? 1));
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf-8"));
  const entities = reg.entities ?? [];
  const staleThreshold = new Date(Date.now() - 7 * 86_400_000)
    .toISOString().slice(0, 10);
  const staleBefore = entities.filter(
    (e) => e.isCanonical && (!(e.marketCapAsOf ?? "") || (e.marketCapAsOf ?? "") < staleThreshold),
  ).length;
  console.log(`registry: ${entities.length} entities, canonical stale before: ${staleBefore}`);

  const targets = entities.filter((e) => e.yahooSymbol);
  const limited = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log(`with yahooSymbol: ${targets.length}${LIMIT ? ` (limited to ${LIMIT})` : ""}`);
  if (DRY) {
    console.log("--dry-run: no network calls, no writes");
    return;
  }

  const state = await getCrumb();
  if (!state) {
    console.error("::error::failed to fetch Yahoo crumb — aborting");
    process.exit(1);
  }
  console.log(`crumb ok · ${state.crumb.slice(0, 4)}…`);

  const rates = await fetchFxRates(state);
  console.log(`FX rates: ${Object.keys(rates).length} currencies`);

  const BATCH_SIZE = 100;
  const asOfDate = new Date().toISOString().slice(0, 10);
  const bySymbol = new Map();
  let batchCount = 0;
  for (let i = 0; i < limited.length; i += BATCH_SIZE) {
    const batch = limited.slice(i, i + BATCH_SIZE).map((e) => e.yahooSymbol);
    let rows = await fetchQuotesRaw(batch, state);
    // Retry once on empty result — could be a transient 401 that
    // needs a fresh crumb.
    if (rows.length === 0) {
      const fresh = await getCrumb();
      if (fresh) rows = await fetchQuotesRaw(batch, fresh);
    }
    for (const row of rows) {
      bySymbol.set(row.yahooSymbol, {
        marketCapUsd: toUsd(row.marketCap, row.currency, rates),
      });
    }
    batchCount++;
    if (batchCount % 5 === 0) {
      console.log(`  batch ${batchCount} · symbols resolved: ${bySymbol.size}/${i + batch.length}`);
    }
    // 500ms gap between batches — Yahoo v7 doesn't rate-limit here in
    // practice, but keeps us well under whatever soft ceilings exist.
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`resolved: ${bySymbol.size}/${limited.length} symbols`);

  let updated = 0;
  let unchanged = 0;
  let noData = 0;
  const tierChanges = [];
  const nextEntities = entities.map((e) => {
    if (!e.yahooSymbol) return e;
    const q = bySymbol.get(e.yahooSymbol);
    if (!q || q.marketCapUsd == null) {
      noData++;
      return e;
    }
    const newTier = capTierFor(q.marketCapUsd);
    const priorTier = e.capTier ?? "unknown";
    const changed = e.marketCapUsd !== q.marketCapUsd || priorTier !== newTier;
    if (!changed) {
      // Refresh marketCapAsOf even when unchanged so the staleness
      // detector doesn't flag actively-refreshed rows.
      unchanged++;
      return { ...e, marketCapAsOf: asOfDate };
    }
    if (priorTier !== newTier) tierChanges.push({ ticker: e.ticker, priorTier, newTier });
    updated++;
    return {
      ...e,
      marketCapUsd: q.marketCapUsd,
      marketCapAsOf: asOfDate,
      capTier: newTier,
    };
  });

  await fs.writeFile(REGISTRY_PATH, JSON.stringify({ ...reg, entities: nextEntities }, null, 2));

  const staleAfter = nextEntities.filter(
    (e) => e.isCanonical && (!(e.marketCapAsOf ?? "") || (e.marketCapAsOf ?? "") < staleThreshold),
  ).length;

  console.log(`\n=== refresh-marketcap ===`);
  console.log(`  updated:      ${updated}`);
  console.log(`  unchanged:    ${unchanged}`);
  console.log(`  no-data:      ${noData}`);
  console.log(`  tier changes: ${tierChanges.length}`);
  console.log(`  canonical stale before: ${staleBefore}`);
  console.log(`  canonical stale after:  ${staleAfter}`);
  if (tierChanges.length > 0) {
    console.log(`\n  tier changes (first 10):`);
    for (const c of tierChanges.slice(0, 10)) {
      console.log(`    ${c.ticker.padEnd(15)} ${c.priorTier} → ${c.newTier}`);
    }
  }
}

main().catch((e) => {
  console.error(`::error::refresh-marketcap crash: ${e.stack ?? e.message}`);
  process.exit(1);
});
