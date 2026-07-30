#!/usr/bin/env node
/**
 * Create past-quarter events for entities that HAVE edgarCik but whose
 * shards are empty/missing (Yahoo returned nothing, so no shard was
 * ever populated). Reads SEC XBRL companyfacts, extracts per-quarter
 * revenue/GP/OI/NI/EPS, builds events, writes shard.
 *
 * Runs AFTER refresh-yahoo-shards.mjs so we only backfill the ones
 * Yahoo genuinely didn't cover.
 *
 * Design mirrors scripts/backfills/rederive-sec-xbrl.mjs's XBRL_MAP +
 * strict-quarter filter, but this script CREATES events instead of
 * mutating existing ones.
 *
 *   node scripts/fill-sec-empty-shards.mjs [--dry] [--limit=N]
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? Number(args.get("limit")) : Infinity;

const SEC_UA = "Earnings Tracker (klpp@bluorbank.lv)";
const REQUEST_TIMEOUT_MS = 20_000;
const SEC_INTERVAL_MS = 1100; // SEC fair-access

// XBRL concept priority — same shape as rederive-sec-xbrl. Only the
// income-statement (duration) subset is used here since we're creating
// events from scratch and don't need balance-sheet snapshots.
const XBRL_MAP = [
  { keys: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"], taxo: "us-gaap", metricKey: "revenue_usd_m", label: "Revenue (M)", scale: 1e6 },
  { keys: ["Revenue", "RevenueFromContractsWithCustomers"], taxo: "ifrs-full", metricKey: "revenue_usd_m", label: "Revenue (M)", scale: 1e6 },
  { keys: ["GrossProfit"], taxo: "us-gaap", metricKey: "gross_profit_usd_m", label: "Gross profit (M)", scale: 1e6 },
  { keys: ["GrossProfit"], taxo: "ifrs-full", metricKey: "gross_profit_usd_m", label: "Gross profit (M)", scale: 1e6 },
  { keys: ["OperatingIncomeLoss"], taxo: "us-gaap", metricKey: "operating_income_usd_m", label: "Operating income (M)", scale: 1e6 },
  { keys: ["ProfitLossFromOperatingActivities"], taxo: "ifrs-full", metricKey: "operating_income_usd_m", label: "Operating income (M)", scale: 1e6 },
  { keys: ["NetIncomeLoss"], taxo: "us-gaap", metricKey: "net_income_usd_m", label: "Net income (M)", scale: 1e6 },
  { keys: ["ProfitLoss", "ProfitLossAttributableToOwnersOfParent"], taxo: "ifrs-full", metricKey: "net_income_usd_m", label: "Net income (M)", scale: 1e6 },
  { keys: ["EarningsPerShareDiluted"], taxo: "us-gaap", metricKey: "eps_diluted_usd", label: "EPS diluted", scale: 1 },
  { keys: ["DilutedEarningsLossPerShare"], taxo: "ifrs-full", metricKey: "eps_diluted_usd", label: "EPS diluted", scale: 1 },
  { keys: ["EarningsPerShareBasic"], taxo: "us-gaap", metricKey: "eps_usd", label: "EPS", scale: 1 },
  { keys: ["BasicEarningsLossPerShare"], taxo: "ifrs-full", metricKey: "eps_usd", label: "EPS", scale: 1 },
];

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}
function isPureQuarter(v) {
  if (!v.start || !v.end) return false;
  const span = (new Date(v.end).getTime() - new Date(v.start).getTime()) / 86_400_000;
  return span >= 80 && span <= 100;
}
function periodFromEnd(iso) {
  const d = new Date(iso);
  return {
    year: d.getUTCFullYear(),
    quarter: Math.floor(d.getUTCMonth() / 3) + 1,
    label: `FY${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`,
  };
}
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}

// Shared rate-limited slot allocator for SEC calls.
let secNextSlot = 0;
async function secLimit() {
  const now = Date.now();
  const t = Math.max(now, secNextSlot);
  secNextSlot = t + SEC_INTERVAL_MS;
  if (t > now) await new Promise((r) => setTimeout(r, t - now));
}

async function fetchCompanyFacts(cik) {
  await secLimit();
  const padded = String(cik).padStart(10, "0");
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (r.status === 429) return { throttled: true };
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return { facts: j.facts ?? {} };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

// From SEC facts, extract per-quarter buckets of the XBRL_MAP metrics.
// Returns Map<periodEnd, Map<metricKey, {value, unit, xbrlKey, form, accession}>>.
function extractQuartersFromFacts(facts) {
  const byEnd = new Map();
  for (const spec of XBRL_MAP) {
    const taxo = facts?.[spec.taxo];
    if (!taxo) continue;
    for (const k of spec.keys) {
      const item = taxo[k];
      if (!item) continue;
      const units = item.units ?? {};
      const unitKey =
        ["USD", "USD/shares"].find((u) => units[u]) ?? Object.keys(units)[0];
      if (!unitKey) continue;
      const values = units[unitKey] ?? [];
      // Group by end-date; keep latest-filed per end-date.
      const byEndDate = new Map();
      for (const v of values) {
        if (!isPureQuarter(v)) continue;
        const cur = byEndDate.get(v.end);
        if (!cur || (v.filed ?? "") > (cur.filed ?? "")) {
          byEndDate.set(v.end, v);
        }
      }
      for (const [end, v] of byEndDate) {
        if (!byEnd.has(end)) byEnd.set(end, new Map());
        const bucket = byEnd.get(end);
        if (bucket.has(spec.metricKey)) continue; // higher-priority spec already won
        bucket.set(spec.metricKey, {
          value: v.val / spec.scale,
          unit: unitKey,
          label: spec.label,
          xbrlKey: k,
          taxonomy: spec.taxo,
          form: v.form,
          accession: v.accn,
        });
      }
      break; // first-hit-per-spec wins
    }
  }
  return byEnd;
}

function buildEvent(entity, endDate, bucket, cik, nowIso) {
  const { label: period } = periodFromEnd(endDate);
  const id = hashId(`${entity.ticker}_${endDate}_${period}`);
  const paddedCik = String(cik).padStart(10, "0");
  const metrics = [];
  for (const [key, d] of bucket) {
    const accessionNoDashes = (d.accession ?? "").replace(/-/g, "");
    const filingUrl = accessionNoDashes
      ? `https://www.sec.gov/Archives/edgar/data/${Number(paddedCik)}/${accessionNoDashes}/`
      : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}`;
    metrics.push({
      key,
      displayLabel: d.label,
      isHeadline: entity.headlineMetrics?.includes(key) ?? false,
      surprisePct: null,
      estimate: null,
      actual: {
        value: d.value,
        unit: d.unit,
        source: {
          url: filingUrl,
          label: `SEC EDGAR · ${d.form ?? "?"} · ${d.xbrlKey}`,
          provenance: "regulatory",
          locator: null,
        },
        asOf: endDate,
        fetchedAt: nowIso,
        method: "filing_manual",
        confidence: 0.98,
      },
      prior: null,
    });
  }
  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period,
    scheduledDate: endDate,
    eventDate: endDate,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    provenance: "sec-xbrl-companyfacts",
    provenanceAsOf: nowIso,
    metrics,
    guidance: [],
    reaction: {
      benchmark: entity.benchmark ?? "",
      baselineDate: null,
      baselineClose: null,
      points: [],
    },
    sources: {
      windowStart: null,
      windowEnd: null,
      capturedAt: null,
      items: [],
      engineStatus: [],
    },
  };
}

async function main() {
  console.log(`fill-sec-empty-shards · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];

  // Find CIK-bearing entities with empty/missing shards.
  const candidates = [];
  for (const e of entities) {
    if (!e.edgarCik) continue;
    if (e.securityType !== "operating") continue;
    const shardPath = path.join(EVENTS_DIR, tickerSlug(e.ticker) + ".json");
    if (!fssync.existsSync(shardPath)) {
      candidates.push(e);
      continue;
    }
    try {
      const j = JSON.parse(fssync.readFileSync(shardPath, "utf-8"));
      const evs = Array.isArray(j) ? j : j.events ?? [];
      if (evs.filter((x) => x.eventDate).length === 0) candidates.push(e);
    } catch {
      candidates.push(e);
    }
  }
  console.log(`Candidates (CIK entities with empty/missing shards): ${candidates.length}`);
  const targets = candidates.slice(0, LIMIT);
  const nowIso = new Date().toISOString();

  // Group by CIK — one SEC fetch per unique companyfacts, then apply
  // to every listing sharing that CIK.
  const byCik = new Map();
  for (const e of targets) {
    if (!byCik.has(e.edgarCik)) byCik.set(e.edgarCik, []);
    byCik.get(e.edgarCik).push(e);
  }
  console.log(`Unique CIKs: ${byCik.size}`);

  const rollup = {
    schema: "fill-sec-empty-shards/v1",
    generatedAt: nowIso,
    totals: {
      candidates: candidates.length,
      ciksProcessed: 0,
      ciksFailed: 0,
      ciksNoQuarters: 0,
      shardsWritten: 0,
      eventsCreated: 0,
    },
    perTicker: [],
  };

  let processed = 0;
  for (const [cik, listings] of byCik) {
    processed++;
    const fr = await fetchCompanyFacts(cik);
    if (fr.error || fr.throttled || !fr.facts) {
      rollup.totals.ciksFailed++;
      for (const l of listings) rollup.perTicker.push({ ticker: l.ticker, cik, status: "sec-error", detail: fr.error ?? "throttled" });
      continue;
    }
    const byEnd = extractQuartersFromFacts(fr.facts);
    if (byEnd.size === 0) {
      rollup.totals.ciksNoQuarters++;
      for (const l of listings) rollup.perTicker.push({ ticker: l.ticker, cik, status: "no-quarters" });
      continue;
    }
    rollup.totals.ciksProcessed++;

    // Build events (same list for every listing under this CIK — SEC-verbatim rule).
    for (const entity of listings) {
      const events = [];
      for (const [endDate, bucket] of byEnd) {
        events.push(buildEvent(entity, endDate, bucket, cik, nowIso));
      }
      events.sort((a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? ""));
      const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
      if (!DRY) {
        fssync.writeFileSync(shardPath, JSON.stringify({ events }, null, 2));
      }
      rollup.totals.shardsWritten++;
      rollup.totals.eventsCreated += events.length;
      rollup.perTicker.push({ ticker: entity.ticker, cik, status: "written", quartersCreated: events.length });
    }

    if (processed % 20 === 0 || processed === byCik.size) {
      console.log(
        `  ${processed}/${byCik.size} CIKs · shards=${rollup.totals.shardsWritten} · events=${rollup.totals.eventsCreated}`,
      );
    }
  }

  console.log(`\n=== fill-sec-empty-shards ===`);
  console.log(`Candidates:               ${candidates.length}`);
  console.log(`CIKs processed:           ${rollup.totals.ciksProcessed}`);
  console.log(`CIKs failed:              ${rollup.totals.ciksFailed}`);
  console.log(`CIKs w/ no quarters:      ${rollup.totals.ciksNoQuarters}`);
  console.log(`Shards written:           ${rollup.totals.shardsWritten}`);
  console.log(`Events created total:     ${rollup.totals.eventsCreated}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "fill-sec-empty-shards.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/fill-sec-empty-shards.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
