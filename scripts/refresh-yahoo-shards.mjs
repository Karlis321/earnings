#!/usr/bin/env node
/**
 * Refresh Yahoo fundamentals-timeseries data for every operating entity's
 * shard. Standalone replica of the daily cron's per-entity Yahoo pass
 * (frontend/app/api/cron/daily/route.ts step 3), extracted so a manual
 * refresh can run outside the Vercel 300s function cap.
 *
 * Behavior:
 *   - Reads data/entity-registry.json for {ticker, yahooSymbol,
 *     securityType, currency, benchmark, companyId}.
 *   - Skips developers + ETFs (no earnings).
 *   - Concurrency 6 (Yahoo tolerates 4-8 without throttling).
 *   - For each entity:
 *       1. Fetch ws/fundamentals-timeseries/v1 for the metric families
 *          the cron cares about (revenue/EBIT/EBITDA/OI/gross_profit/
 *          net_income/eps_basic/eps_diluted).
 *       2. Group by quarter-end (asOfDate).
 *       3. Read the ticker's shard.
 *       4. For each quarter, find matching event (by period OR by
 *          close eventDate ±45d) — merge metrics with provenance-aware
 *          upsert (yahoo-timeseries can add missing values but not
 *          overwrite sec-xbrl-companyfacts).
 *       5. Compare old vs new shard JSON; skip write if unchanged.
 *   - Emits scripts/audits/refresh-yahoo-shards.json with per-entity
 *     rollup (fetched, quarters, added-metrics, replaced-metrics).
 *
 *   node scripts/refresh-yahoo-shards.mjs [--dry] [--limit=N]
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

const UA = "Mozilla/5.0 (refresh-yahoo-shards)";
const YAHOO_HEADERS = { "User-Agent": UA, Accept: "*/*" };
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;

// Metric families matching the cron's XBRL_MAP + Yahoo mapping.
// scale=1e6 means Yahoo returns raw dollars; we divide to millions.
// scale=1 means already per-share (EPS).
const TS_MAP = {
  quarterlyTotalRevenue: { key: "revenue_usd_m", label: "Revenue (M)", scale: 1e6 },
  quarterlyEBIT: { key: "ebit_usd_m", label: "EBIT (M)", scale: 1e6 },
  quarterlyEBITDA: { key: "ebitda_usd_m", label: "EBITDA (M)", scale: 1e6 },
  quarterlyOperatingIncome: { key: "operating_income_usd_m", label: "Operating income (M)", scale: 1e6 },
  quarterlyGrossProfit: { key: "gross_profit_usd_m", label: "Gross profit (M)", scale: 1e6 },
  quarterlyNetIncome: { key: "net_income_usd_m", label: "Net income (M)", scale: 1e6 },
  quarterlyBasicEPS: { key: "eps_usd", label: "EPS", scale: 1 },
  quarterlyDilutedEPS: { key: "eps_diluted_usd", label: "EPS diluted", scale: 1 },
};

// Provenance rank — mirrors frontend/server/lib/cronDetections.ts. Higher
// wins. yahoo-timeseries is 90. sec-xbrl-companyfacts is 100. So this
// script upgrades yahoo-earnings-chart (20), fmp (30), sec-submissions (70)
// but never overwrites sec-xbrl-companyfacts.
function provRank(prov) {
  return {
    "yahoo-earnings-chart": 20,
    fmp: 30,
    "sec-submissions": 70,
    "yahoo-timeseries": 90,
    "sec-xbrl-companyfacts": 100,
    filing_manual: 95,
    bloomberg_manual: 95,
    llm_extracted: 60,
  }[prov ?? ""] ?? 50;
}

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}
function periodFromEndDate(iso) {
  const d = new Date(iso);
  return {
    year: d.getUTCFullYear(),
    quarter: Math.floor(d.getUTCMonth() / 3) + 1,
    label: `FY${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`,
  };
}
function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  const setCookies = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const raw of setCookies) {
    const f = raw.split(";", 1)[0].trim();
    const eq = f.indexOf("=");
    if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1));
  }
  COOKIE = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: COOKIE },
  });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

async function fetchTimeseries(symbol) {
  if (!CRUMB || !COOKIE) return { error: "no-crumb" };
  const now = Math.floor(Date.now() / 1000);
  const from = now - 5 * 365 * 24 * 3600;
  const types = Object.keys(TS_MAP).join(",");
  const url =
    `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
    `?type=${types}&period1=${from}&period2=${now}&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { ...YAHOO_HEADERS, Cookie: COOKIE },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return { series: j.timeseries?.result ?? [] };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

function collectByQuarter(seriesResults) {
  const byQuarter = new Map();
  for (const r of seriesResults) {
    const type = r.meta?.type?.[0];
    if (!type || !TS_MAP[type]) continue;
    const spec = TS_MAP[type];
    const dataKey = Object.keys(r).find((k) => k !== "meta" && k !== "timestamp");
    if (!dataKey) continue;
    const data = r[dataKey] ?? [];
    for (const d of data) {
      if (!d) continue;
      const asOfDate = d.asOfDate;
      const raw = d.reportedValue?.raw;
      if (asOfDate == null || raw == null) continue;
      if (d.periodType && d.periodType !== "3M") continue;
      if (!byQuarter.has(asOfDate)) byQuarter.set(asOfDate, new Map());
      const bucket = byQuarter.get(asOfDate);
      if (bucket.has(spec.key)) continue;
      bucket.set(spec.key, {
        value: raw / spec.scale,
        unit: d.currencyCode ?? "USD",
        label: spec.label,
      });
    }
  }
  return byQuarter;
}

function buildFact(entity, asOfDate, metricSpec, nowIso) {
  const sym = entity.yahooSymbol ?? "";
  return {
    value: metricSpec.value,
    unit: metricSpec.unit,
    source: {
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/financials`,
      label: "Yahoo · fundamentals-timeseries",
      provenance: "wire",
      locator: null,
    },
    asOf: asOfDate,
    fetchedAt: nowIso,
    method: "yahoo",
    confidence: 0.85,
  };
}

function buildEvent(entity, asOfDate, bucket, nowIso) {
  const { label: period } = periodFromEndDate(asOfDate);
  const id = hashId(`${entity.ticker}_${asOfDate}_${period}`);
  const metrics = [];
  for (const [k, d] of bucket) {
    metrics.push({
      key: k,
      displayLabel: d.label,
      isHeadline: entity.headlineMetrics?.includes(k) ?? false,
      surprisePct: null,
      estimate: null,
      actual: buildFact(entity, asOfDate, d, nowIso),
      prior: null,
    });
  }
  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period,
    scheduledDate: asOfDate,
    eventDate: asOfDate,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    provenance: "yahoo-timeseries",
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

// Provenance-aware metric upsert on a single event. Returns { added,
// replaced, superseded } counters.
function upsertMetrics(event, incomingBucket, entity, asOfDate, nowIso) {
  const stats = { added: 0, replaced: 0, unchanged: 0 };
  if (!Array.isArray(event.metrics)) event.metrics = [];
  const incomingRank = provRank("yahoo-timeseries");
  for (const [key, d] of incomingBucket) {
    const existing = event.metrics.find((m) => m.key === key);
    if (!existing) {
      event.metrics.push({
        key,
        displayLabel: d.label,
        isHeadline: entity.headlineMetrics?.includes(key) ?? false,
        surprisePct: null,
        estimate: null,
        actual: buildFact(entity, asOfDate, d, nowIso),
        prior: null,
      });
      stats.added++;
      continue;
    }
    const curActual = existing.actual;
    if (!curActual || curActual.value == null) {
      existing.actual = buildFact(entity, asOfDate, d, nowIso);
      stats.added++;
      continue;
    }
    // Provenance rank on the existing metric: derive from its source label.
    const curLabel = curActual.source?.label ?? "";
    const curProv =
      curLabel.includes("SEC EDGAR") ? "sec-xbrl-companyfacts"
      : curLabel.includes("submissions") ? "sec-submissions"
      : curLabel.includes("earningsChart") ? "yahoo-earnings-chart"
      : curLabel.includes("timeseries") ? "yahoo-timeseries"
      : curLabel.toLowerCase().includes("fmp") ? "fmp"
      : "unknown";
    const curRank = provRank(curProv);
    // Never overwrite SEC or manually-filed sources.
    if (curRank >= incomingRank) {
      stats.unchanged++;
      continue;
    }
    // Push existing to superseded before overwriting.
    if (!Array.isArray(existing.superseded)) existing.superseded = [];
    existing.superseded.push({
      value: curActual.value,
      unit: curActual.unit,
      source: curActual.source?.label ?? null,
      from_provenance: curProv,
    });
    existing.actual = buildFact(entity, asOfDate, d, nowIso);
    stats.replaced++;
  }
  return stats;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  console.log(`refresh-yahoo-shards · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT} concurrency=${CONCURRENCY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).filter(
    (e) =>
      e.securityType === "operating" &&
      typeof e.yahooSymbol === "string" &&
      e.yahooSymbol.length > 0,
  );
  const targets = entities.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} operating entities with Yahoo symbols`);

  await primeCrumb();
  if (!CRUMB) {
    console.error("Yahoo crumb prime failed");
    process.exit(1);
  }
  console.log(`crumb=${CRUMB.slice(0, 6)}…`);

  const nowIso = new Date().toISOString();
  const rollup = {
    schema: "refresh-yahoo-shards/v1",
    generatedAt: nowIso,
    totals: {
      fetched: 0,
      fetchErrors: 0,
      empty: 0,
      shardsRead: 0,
      shardsWritten: 0,
      metricsAdded: 0,
      metricsReplaced: 0,
      metricsUnchanged: 0,
      eventsCreated: 0,
    },
    perEntity: [],
  };

  let processed = 0;
  await pool(targets, CONCURRENCY, async (entity) => {
    processed++;
    const r = await fetchTimeseries(entity.yahooSymbol);
    rollup.totals.fetched++;
    if (r.error) {
      rollup.totals.fetchErrors++;
      rollup.perEntity.push({ ticker: entity.ticker, status: "fetch-error", detail: r.error });
      if (processed % 100 === 0) {
        console.log(
          `  ${processed}/${targets.length} · added=${rollup.totals.metricsAdded} · replaced=${rollup.totals.metricsReplaced} · unchanged=${rollup.totals.metricsUnchanged} · shards=${rollup.totals.shardsWritten}`,
        );
      }
      return;
    }
    const byQuarter = collectByQuarter(r.series ?? []);
    if (byQuarter.size === 0) {
      rollup.totals.empty++;
      rollup.perEntity.push({ ticker: entity.ticker, status: "empty" });
      if (processed % 100 === 0) {
        console.log(
          `  ${processed}/${targets.length} · added=${rollup.totals.metricsAdded} · replaced=${rollup.totals.metricsReplaced} · unchanged=${rollup.totals.metricsUnchanged} · shards=${rollup.totals.shardsWritten}`,
        );
      }
      return;
    }

    // Read shard.
    const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
    let shardRaw;
    try {
      shardRaw = JSON.parse(await fs.readFile(shardPath, "utf-8"));
      rollup.totals.shardsRead++;
    } catch {
      shardRaw = { events: [] };
    }
    const wrapped = !Array.isArray(shardRaw);
    const events = wrapped ? shardRaw.events ?? [] : shardRaw;
    const originalJson = JSON.stringify(events);

    const perEntity = { ticker: entity.ticker, quarters: 0, added: 0, replaced: 0, unchanged: 0, created: 0, status: "ok" };

    for (const [asOfDate, bucket] of byQuarter) {
      const { year, quarter, label } = periodFromEndDate(asOfDate);
      const targetTs = new Date(asOfDate).getTime();
      // Find matching event: period label first, then close date fallback.
      let matching = events.find((ev) => {
        const m = /^FY(\d{4})\s+Q(\d)$/.exec(ev.period ?? "");
        return m && Number(m[1]) === year && Number(m[2]) === quarter;
      });
      if (!matching) {
        matching = events.find((ev) => {
          if (!ev.eventDate) return false;
          return daysBetween(ev.eventDate, asOfDate) <= 45;
        });
      }
      if (matching) {
        // Refresh eventDate if placeholder shell 15th → real quarter-end.
        if (/-15$/.test(matching.eventDate ?? "") && !/-15$/.test(asOfDate)) {
          matching.eventDate = asOfDate;
          matching.eventDateSource = "yahoo-timeseries-asOfDate";
        }
        const s = upsertMetrics(matching, bucket, entity, asOfDate, nowIso);
        perEntity.added += s.added;
        perEntity.replaced += s.replaced;
        perEntity.unchanged += s.unchanged;
        rollup.totals.metricsAdded += s.added;
        rollup.totals.metricsReplaced += s.replaced;
        rollup.totals.metricsUnchanged += s.unchanged;
      } else {
        const ev = buildEvent(entity, asOfDate, bucket, nowIso);
        events.push(ev);
        perEntity.created++;
        rollup.totals.eventsCreated++;
        rollup.totals.metricsAdded += bucket.size;
        perEntity.added += bucket.size;
      }
      perEntity.quarters++;
    }

    // Only write if content changed.
    const nextJson = JSON.stringify(events);
    if (nextJson !== originalJson && !DRY) {
      const body = wrapped ? { ...shardRaw, events } : events;
      fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
      perEntity.status = "written";
    } else if (nextJson === originalJson) {
      perEntity.status = "unchanged";
    } else {
      perEntity.status = "dry-would-write";
    }
    rollup.perEntity.push(perEntity);

    if (processed % 100 === 0 || processed === targets.length) {
      console.log(
        `  ${processed}/${targets.length} · added=${rollup.totals.metricsAdded} · replaced=${rollup.totals.metricsReplaced} · unchanged=${rollup.totals.metricsUnchanged} · shards=${rollup.totals.shardsWritten}`,
      );
    }
  });

  console.log(`\n=== refresh-yahoo-shards ===`);
  console.log(`Entities scanned:         ${processed}`);
  console.log(`Fetch errors:             ${rollup.totals.fetchErrors}`);
  console.log(`Empty timeseries:         ${rollup.totals.empty}`);
  console.log(`Shards read:              ${rollup.totals.shardsRead}`);
  console.log(`Shards written:           ${rollup.totals.shardsWritten}`);
  console.log(`Metrics added:            ${rollup.totals.metricsAdded}`);
  console.log(`Metrics replaced:         ${rollup.totals.metricsReplaced}`);
  console.log(`Metrics unchanged:        ${rollup.totals.metricsUnchanged}`);
  console.log(`New events created:       ${rollup.totals.eventsCreated}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "refresh-yahoo-shards.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/refresh-yahoo-shards.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
