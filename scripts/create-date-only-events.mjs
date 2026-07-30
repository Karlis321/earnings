#!/usr/bin/env node
/**
 * For every ticker in refine-stale-via-calendar.json's
 * confirmedStale list — Yahoo says the report has been filed but
 * we don't have any past event covering that period — create a
 * DATE-ONLY past event. No numbers (per Stage 3 rule: never hand-
 * enter numbers). Just eventDate + period + sourceLink so the
 * dashboard shows the report happened while flagging the gap.
 *
 *   node scripts/create-date-only-events.mjs [--dry]
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

const DRY = process.argv.includes("--dry");
const IN_FILE = path.join(OUT_DIR, "refine-stale-via-calendar.json");

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}

// Regional gap notes — where the numbers ACTUALLY live for each
// exchange suffix, so the audit surfaces named ingest-capability
// asks instead of a generic "data missing".
function regionalGap(ticker) {
  const suffix = (ticker.split(/\s+/)[1] ?? "").toUpperCase();
  const m = {
    KS: "Korean · KIND/DART data (kind.krx.co.kr, opendart.fss.or.kr). Yahoo lags Korean XBRL by ~24h.",
    KQ: "Korean · KIND/DART data (kind.krx.co.kr, opendart.fss.or.kr). Yahoo lags Korean XBRL by ~24h.",
    JP: "Japanese · TDnet/EDINET (release.tdnet.info, disclosure.edinet-fsa.go.jp). Yahoo publishes JP earnings via Reuters wire; the raw XBRL is faster.",
    IJ: "Indonesian · IDX (idx.co.id/en). Yahoo lags Indonesian filings by ~24-48h.",
    IN: "Indian · BSE/NSE (bseindia.com, nseindia.com). Yahoo covers some but with lag; direct exchange feeds are same-day.",
    IT: "Italian · Borsa Italiana (borsaitaliana.it). Yahoo often lags EU exchanges by a day.",
    HK: "Hong Kong · HKEX (hkexnews.hk). Yahoo covers major HK names, but lag on smaller.",
    GR: "German · Deutsche Börse (deutsche-boerse.com). Yahoo has partial coverage — EFRAG registry has structured filings.",
    IM: "Italian · Borsa Italiana Milano (borsaitaliana.it). Yahoo lag ~1 day for MTA-listed names.",
  };
  return m[suffix] ?? `Foreign exchange ${suffix} · no free structured source — Yahoo aggregates with lag.`;
}

async function main() {
  console.log(`create-date-only-events · dry=${DRY}`);
  const audit = JSON.parse(await fs.readFile(IN_FILE, "utf-8"));
  const targets = audit.confirmedStale ?? [];
  console.log(`Targets: ${targets.length}`);

  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);

  const rollup = {
    schema: "create-date-only-events/v1",
    generatedAt: new Date().toISOString(),
    totals: { targets: targets.length, created: 0, alreadyHad: 0, noEntity: 0, shardsWritten: 0 },
    ingestGapsByRegion: {},
    created: [],
  };
  const nowIso = new Date().toISOString();

  for (const t of targets) {
    const entity = byTicker.get(t.ticker);
    if (!entity) { rollup.totals.noEntity++; continue; }
    const shardPath = path.join(EVENTS_DIR, tickerSlug(t.ticker) + ".json");
    let shard;
    try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); } catch { shard = { events: [] }; }
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    // Skip if we already have a past event covering the expected period.
    const already = events.find((e) => e.eventDate && e.period === t.expectedPeriod);
    if (already) { rollup.totals.alreadyHad++; continue; }
    // Remove the corresponding upcoming shell (its period is landing).
    const remaining = events.filter((e) => !(e.eventDate == null && e.period === t.expectedPeriod));

    const newEvent = {
      id: hashId(`${t.ticker}_${t.yahooEarningsDate}_${t.expectedPeriod ?? ""}`),
      ticker: t.ticker,
      kind: "earnings",
      period: t.expectedPeriod,
      scheduledDate: t.yahooEarningsDate,
      eventDate: t.yahooEarningsDate,
      eventDateSource: "yahoo-calendarEvents",
      timing: null,
      expectation: "unset",
      guidanceMove: null,
      freshness: "fresh",
      provenance: "yahoo-earnings-chart",
      provenanceAsOf: nowIso,
      metrics: [],
      guidance: [],
      reaction: {
        benchmark: entity.benchmark ?? "",
        baselineDate: null,
        baselineClose: null,
        points: [
          { horizon: "d1", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "d3", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "w1", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          { horizon: "m1", absReturn: null, excessReturn: null, benchmark: entity.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
        ],
      },
      sources: { windowStart: null, windowEnd: null, capturedAt: null, items: [], engineStatus: [] },
      sourceLink: entity.yahooSymbol
        ? { url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/earnings-history`, kind: "fallback" }
        : null,
    };
    remaining.push(newEvent);

    if (!DRY) {
      const body = wrapped ? { ...shard, events: remaining } : remaining;
      fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
    rollup.totals.created++;
    const gap = regionalGap(t.ticker);
    rollup.ingestGapsByRegion[gap] = (rollup.ingestGapsByRegion[gap] ?? 0) + 1;
    rollup.created.push({ ticker: t.ticker, period: t.expectedPeriod, eventDate: t.yahooEarningsDate, gap });
  }

  console.log(`\n=== create-date-only-events ===`);
  console.log(`Targets:             ${rollup.totals.targets}`);
  console.log(`Created date-only:   ${rollup.totals.created}`);
  console.log(`Already had event:   ${rollup.totals.alreadyHad}`);
  console.log(`Shards written:      ${rollup.totals.shardsWritten}`);
  console.log("\nNamed ingest-capability gaps:");
  for (const [gap, count] of Object.entries(rollup.ingestGapsByRegion)) {
    console.log(`  [${count}]  ${gap}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "create-date-only-events.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/create-date-only-events.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
