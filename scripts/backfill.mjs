#!/usr/bin/env node
/**
 * W8 backfill / cutover seed.
 *
 * Writes the four persistence-store JSON files the git-snapshot layer reads
 * from:
 *
 *   data/entity-registry.json   ← ENTITY_REGISTRY fixture (17 tickers)
 *   data/metric-dictionary.json ← METRIC_LABELS fixture
 *   data/shared-state.json      ← watchlist + custom sources + themes
 *   data/earnings.json          ← event shells per ticker, enriched from Yahoo
 *                                 (nextEarningsDate + lastQuarter EPS actual)
 *
 * The intent is a one-shot commit to bring the repo from fixture-only to
 * store-backed. Run once from your machine, `git add data/`, commit, deploy.
 * After the cutover the daily cron takes over — appending sources, maturing
 * reactions, upserting next-events, and detecting restatements.
 *
 * Usage:
 *   node scripts/backfill.mjs                # full seed
 *   node scripts/backfill.mjs --dry          # print but don't write
 *   node scripts/backfill.mjs --ticker="INTC US"   # single ticker only
 *   node scripts/backfill.mjs --skip-yahoo   # skip Yahoo enrichment (fixtures only)
 *
 * Yahoo occasionally rate-limits datacenter IPs on longer-range queries —
 * run from your residential connection.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const ONLY = args.get("ticker") || null;
const SKIP_YAHOO = args.get("skip-yahoo") === true;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const EXCHANGE_MAP = {
  US: ["NMS", "NYQ", "ASE", "NGM", "NCM", "PCX", "NYS", "OEM", "OQX", "BTS"],
  CN: ["TOR", "VAN", "CVE", "NEO", "CDNX", "CDX", "CNX"],
  FP: ["PAR"],
  FH: ["HEL"],
  PA: ["PAR"],
};

// ---------- Registry + dictionary loading ----------

async function loadFixture(relPath) {
  const p = path.join(ROOT, "frontend", "lib", "fixtures", relPath);
  return fs.readFile(p, "utf8");
}

// Extract the ENTITY_REGISTRY constant. Regex-only; runs on the TS source so
// we can seed without transpiling. The keys we care about are all string /
// boolean / array-of-string literals so this is safe.
function parseEntities(src) {
  const start = src.indexOf("ENTITY_REGISTRY: Entity[]");
  if (start < 0) throw new Error("ENTITY_REGISTRY not found in fixture");
  // The declaration is `ENTITY_REGISTRY: Entity[] = [ ... ]`. The first
  // `[` after `start` is the `Entity[]` type annotation, not the value —
  // skip past the `=` first so we land on the value's opening bracket.
  const eqIdx = src.indexOf("=", start);
  if (eqIdx < 0) throw new Error("ENTITY_REGISTRY assignment not found");
  const openIdx = src.indexOf("[", eqIdx);
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) throw new Error("ENTITY_REGISTRY array unterminated");
  const arr = src.slice(openIdx, endIdx + 1);
  // Convert TS-object literals to JSON: unquoted keys → quoted, single → double.
  const jsonish = arr
    .replace(/,(\s*[}\]])/g, "$1") // trailing commas
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'([^']*)'/g, (_, s) => `"${s.replace(/"/g, '\\"')}"`);
  return JSON.parse(jsonish);
}

function parseMetricLabels(src) {
  const start = src.indexOf("METRIC_LABELS");
  if (start < 0) throw new Error("METRIC_LABELS not found");
  // Skip past the "=" so we don't parse the TS type annotation that
  // precedes it: `METRIC_LABELS: Record<string, { label: string; unit:
  // string }> = { ... }`.
  const eqIdx = src.indexOf("=", start);
  if (eqIdx < 0) throw new Error("METRIC_LABELS assignment not found");
  const openIdx = src.indexOf("{", eqIdx);
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  const obj = src.slice(openIdx, endIdx + 1);
  const jsonish = obj
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'([^']*)'/g, (_, s) => `"${s.replace(/"/g, '\\"')}"`);
  return JSON.parse(jsonish);
}

// ---------- Yahoo enrichment ----------

async function yahooResolve(bbTicker) {
  const [sym, exch = "US"] = bbTicker.split(/\s+/);
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=10&newsCount=0`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Yahoo search ${sym} → ${r.status}`);
  const j = await r.json();
  const acceptable = EXCHANGE_MAP[exch.toUpperCase()] ?? [];
  const match =
    j.quotes.find(
      (q) =>
        q.quoteType === "EQUITY" &&
        (acceptable.length === 0 || acceptable.includes(q.exchange)) &&
        (q.symbol === sym || q.symbol.split(".")[0] === sym),
    ) || j.quotes.find((q) => q.quoteType === "EQUITY");
  if (!match) throw new Error(`No Yahoo equity for ${bbTicker}`);
  return { yahooSymbol: match.symbol, name: match.longname ?? match.shortname };
}

// ---------- Yahoo crumb + cookie handshake ----------
// v10 quoteSummary rejects unauthed reads with "Invalid Crumb" since 2024.
// Handshake:
//   1. GET https://finance.yahoo.com/  → A1/A3/B cookies
//   2. GET https://query2.finance.yahoo.com/v1/test/getcrumb  → crumb string
// One-shot for the whole backfill; the process is short-lived enough that
// TTL caching isn't necessary.
let CRUMB = null;
let COOKIE_HEADER = "";

async function primeCrumb() {
  if (CRUMB) return CRUMB;
  // fc.yahoo.com seeds A3 without going through the GDPR consent redirect
  // that finance.yahoo.com forces. 404 body, but Set-Cookie is what we want.
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "manual",
  });
  const setCookies =
    typeof r1.headers.getSetCookie === "function"
      ? r1.headers.getSetCookie()
      : [r1.headers.get("set-cookie")].filter(Boolean);
  const pairs = new Map();
  for (const raw of setCookies) {
    const firstPart = raw.split(";", 1)[0]?.trim();
    if (!firstPart) continue;
    const eq = firstPart.indexOf("=");
    if (eq < 0) continue;
    const name = firstPart.slice(0, eq).trim();
    const value = firstPart.slice(eq + 1).trim();
    if (name && value) pairs.set(name, value);
  }
  COOKIE_HEADER = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE_HEADER) return null;

  const r2 = await fetch(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: {
        "User-Agent": UA,
        Accept: "text/plain",
        Cookie: COOKIE_HEADER,
      },
    },
  );
  if (!r2.ok) return null;
  const txt = (await r2.text()).trim();
  if (!txt || /Unauthorized|<html/i.test(txt)) return null;
  CRUMB = txt;
  return CRUMB;
}

async function yahooEarningsQ(yahooSymbol) {
  const crumb = await primeCrumb();
  if (!crumb) return null;
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=earnings,calendarEvents&formatted=true&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Cookie: COOKIE_HEADER,
    },
  });
  if (!r.ok) return null;
  const j = await r.json();
  const result = j.quoteSummary?.result?.[0];
  if (!result) return null;
  const dates = result.calendarEvents?.earnings?.earningsDate ?? [];
  let nextEarningsDate = null;
  for (const d of dates) {
    if (typeof d.raw === "number") {
      const iso = new Date(d.raw * 1000).toISOString().slice(0, 10);
      if (!nextEarningsDate || iso < nextEarningsDate) nextEarningsDate = iso;
    }
  }
  const quarterly = result.earnings?.earningsChart?.quarterly ?? [];
  const last = quarterly[quarterly.length - 1] ?? null;
  return {
    nextEarningsDate,
    lastQuarter: last
      ? {
          period: last.date ?? "",
          actual: last.actual?.raw ?? null,
          estimate: last.estimate?.raw ?? null,
        }
      : null,
  };
}

// ---------- Event shell + period helpers ----------

function periodFromReportingDate(iso) {
  const d = new Date(iso);
  const m = d.getUTCMonth() + 1;
  const y = d.getUTCFullYear();
  if (m <= 3) return `FY${y - 1} Q4`;
  if (m <= 6) return `FY${y} Q1`;
  if (m <= 9) return `FY${y} Q2`;
  return `FY${y} Q3`;
}

function nextEventId(ticker, scheduledDate) {
  const key = `${ticker}::${scheduledDate}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "evt-" + (h >>> 0).toString(36).padStart(7, "0").slice(0, 8);
}

function addDays(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildEventShell(entity, scheduledDate, period, epsActual) {
  const id = nextEventId(entity.ticker, scheduledDate);
  const points = ["d1", "d3", "w1", "m1"].map((h) => ({
    horizon: h,
    absReturn: null,
    excessReturn: null,
    benchmark: entity.benchmark,
    computedAt: null,
    populatesOn: addDays(scheduledDate, ({ d1: 3, d3: 5, w1: 7, m1: 23 })[h]),
  }));
  const metrics = [];
  // Seed one Fact per headline metric so the DeepLinkButton has a target;
  // value stays null until manual entry or a future ingestion fills it.
  for (const key of entity.headlineMetrics) {
    let seed = null;
    // Only EPS gets a Yahoo-actual seed for now.
    if (/^eps/i.test(key) && typeof epsActual === "number") {
      seed = {
        value: epsActual,
        unit: "USD",
        source: {
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.ticker.split(" ")[0])}/earnings`,
          label: "Yahoo Finance",
          provenance: "wire",
          locator: null,
        },
        asOf: new Date().toISOString().slice(0, 10),
        fetchedAt: new Date().toISOString(),
        method: "yahoo",
        confidence: 0.85,
      };
    }
    metrics.push({
      key,
      displayLabel: key,
      isHeadline: true,
      surprisePct: null,
      estimate: null,
      actual: seed,
      prior: null,
    });
  }
  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period,
    scheduledDate,
    eventDate: null,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    metrics,
    guidance: [],
    reaction: {
      benchmark: entity.benchmark,
      baselineDate: null,
      baselineClose: null,
      points,
    },
    sources: {
      windowStart: addDays(scheduledDate, -2),
      windowEnd: addDays(scheduledDate, 35),
      capturedAt: null,
      items: [],
      engineStatus: [],
    },
  };
}

// ---------- Main ----------

async function main() {
  console.log(`W8 backfill · dry=${DRY} · yahoo=${!SKIP_YAHOO}`);
  const registrySrc = await loadFixture("registry.ts");
  const entities = parseEntities(registrySrc);
  const metricLabels = parseMetricLabels(registrySrc);
  const filtered = ONLY ? entities.filter((e) => e.ticker === ONLY) : entities;

  // ---- entity-registry.json ----
  const entityRegistry = {
    schema: "entity-registry/v1",
    entities,
  };

  // ---- metric-dictionary.json ----
  const dictionary = {
    schema: "metric-dictionary/v1",
    metrics: Object.fromEntries(
      Object.entries(metricLabels).map(([k, v]) => [
        k,
        {
          label: v.label,
          unit: v.unit,
          requiresIsAdjusted: /^eps/.test(k),
          description: null,
        },
      ]),
    ),
  };

  // ---- shared-state.json ----
  // SHARED_STATE in the TS fixture uses runtime expressions (ENTITY_REGISTRY
  // .filter().map()) that we can't safely eval. Derive the seed directly:
  // watchlist = all core entities. customSources starts empty — the analyst
  // adds them via the admin UI. Themes match the sector tags we ship with.
  const sharedState = {
    schema: "shared-state/v1",
    watchlist: entities.filter((e) => e.isCore).map((e) => e.ticker),
    customSources: [],
    themes: [
      { id: "copper", label: "Copper", active: true },
      { id: "gold", label: "Gold", active: true },
      { id: "semiconductors", label: "Semiconductors", active: true },
      { id: "uranium", label: "Uranium", active: true },
    ],
    lastCommit: new Date().toISOString(),
  };

  // ---- earnings.json (event shells + Yahoo enrichment) ----
  const events = [];
  const perTickerReport = [];
  for (const entity of filtered) {
    if (entity.securityType !== "operating") {
      perTickerReport.push({ ticker: entity.ticker, skipped: "non-operating" });
      continue;
    }
    let yahoo = null;
    if (!SKIP_YAHOO) {
      try {
        const { yahooSymbol } = await yahooResolve(entity.ticker);
        yahoo = await yahooEarningsQ(yahooSymbol);
        await new Promise((r) => setTimeout(r, 300)); // gentle to Yahoo
      } catch (e) {
        perTickerReport.push({ ticker: entity.ticker, warn: e.message });
      }
    }
    if (yahoo?.nextEarningsDate) {
      const period = periodFromReportingDate(yahoo.nextEarningsDate);
      events.push(
        buildEventShell(entity, yahoo.nextEarningsDate, period, yahoo.lastQuarter?.actual),
      );
      perTickerReport.push({
        ticker: entity.ticker,
        nextEarningsDate: yahoo.nextEarningsDate,
        lastEpsActual: yahoo.lastQuarter?.actual ?? null,
      });
    } else {
      perTickerReport.push({
        ticker: entity.ticker,
        warn: "no nextEarningsDate; no event seeded",
      });
    }
  }

  const earnings = {
    schema: "earnings/v1",
    lastUpdated: new Date().toISOString(),
    events,
  };

  // ---- Write ----
  const files = [
    ["entity-registry.json", entityRegistry],
    ["metric-dictionary.json", dictionary],
    ["shared-state.json", sharedState],
    ["earnings.json", earnings],
  ];
  if (DRY) {
    console.log("\nDry run — would write:");
    for (const [name, obj] of files) {
      const bytes = Buffer.byteLength(JSON.stringify(obj, null, 2), "utf8");
      console.log(`  data/${name}  (${bytes} bytes)`);
    }
  } else {
    await fs.mkdir(OUT_DIR, { recursive: true });
    for (const [name, obj] of files) {
      const p = path.join(OUT_DIR, name);
      await fs.writeFile(p, JSON.stringify(obj, null, 2));
      console.log(`  ✓ wrote ${p}`);
    }
  }

  console.log("\nPer-ticker report:");
  for (const r of perTickerReport) console.log(" ", JSON.stringify(r));
  console.log(
    `\nDone. ${events.length} event shell(s) built from ${filtered.length} ticker(s).`,
  );
  if (!DRY) {
    console.log(
      "\nNext: git add data/ && git commit -m 'W8 seed' && git push",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
