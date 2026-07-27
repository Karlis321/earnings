#!/usr/bin/env node
/**
 * Mirror the reactionMaturation step: for each event whose scheduledDate
 * has passed and whose baselineDate is null, fetch the security's bars
 * from Yahoo and seed baseline + mature every horizon whose populatesOn
 * is past.
 *
 *   node scripts/seed-reaction-baselines.mjs        # write
 *   node scripts/seed-reaction-baselines.mjs --dry  # report only
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

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const OFFSETS = { d1: 1, d3: 3, w1: 5, m1: 21 };
const HORIZONS = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS = { d1: 1, d3: 3, w1: 5, m1: 21 };

function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function horizonPopulatesOn(anchor, h) {
  return addDays(anchor, HORIZON_TRADING_DAYS[h] + 2);
}
// Idempotent — matches frontend/server/lib/cronDetections.seedReactionPoints.
function seedReactionPoints(event) {
  if ((event.reaction.points ?? []).length > 0) return false;
  const anchor = event.eventDate ?? event.scheduledDate;
  event.reaction.points = HORIZONS.map((h) => ({
    horizon: h,
    absReturn: null,
    excessReturn: null,
    benchmark: event.reaction.benchmark ?? "",
    computedAt: null,
    populatesOn: horizonPopulatesOn(anchor, h),
  }));
  return true;
}

// Copy of frontend/server/lib/reactionMaturation BENCHMARK_MAP so this
// script matches prod. Keep in sync.
const BENCHMARK_MAP = {
  SOX: "^SOX", SPX: "^GSPC", NDX: "^NDX", RUT: "^RUT",
  DAX: "^GDAXI", FTSE: "^FTSE", N225: "^N225",
  BOVESPA: "^BVSP", IBOV: "^BVSP", TSX: "^GSPTSE",
  "HG=F": "HG=F", "GC=F": "GC=F", "SI=F": "SI=F", "CL=F": "CL=F",
  URA: "URA", XLE: "XLE", XLK: "XLK",
};

function toBenchmarkSymbol(benchmark) {
  if (!benchmark) return null;
  return BENCHMARK_MAP[benchmark] ?? benchmark;
}

const barsCache = new Map();
// 1y range so events reported earlier in the year still find a real
// baseline bar (matureEventReaction in prod uses 3mo, but for backfilling
// months of history we need a wider window). Bars are per-symbol cached.
async function yahooSeries(symbol) {
  if (barsCache.has(symbol)) return barsCache.get(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) { barsCache.set(symbol, []); return []; }
    const j = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) { barsCache.set(symbol, []); return []; }
    const ts = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const close = closes[i];
      if (close == null) continue;
      const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      bars.push({ date: d, close });
    }
    barsCache.set(symbol, bars);
    return bars;
  } catch {
    barsCache.set(symbol, []);
    return [];
  }
}

// Reject a match if the found bar is more than 7 calendar days after the
// anchor — a real reporting-day close is within a couple of trading days
// (holidays allowed), so anything further out means the anchor pre-dates
// the bar window and we shouldn't fabricate a baseline.
const BASELINE_TOLERANCE_DAYS = 7;
function pickBaselineIdx(bars, anchorDate, timing) {
  const anchorTs = new Date(anchorDate).getTime();
  const cutoff = anchorTs + BASELINE_TOLERANCE_DAYS * 86_400_000;
  const idx =
    timing === "AMC"
      ? bars.findIndex((b) => new Date(b.date).getTime() > anchorTs)
      : bars.findIndex((b) => new Date(b.date).getTime() >= anchorTs);
  if (idx < 0) return -1;
  if (new Date(bars[idx].date).getTime() > cutoff) return -1;
  return idx;
}

function findBaselineIdxByDate(bars, baselineDate) {
  const exact = bars.findIndex((b) => b.date === baselineDate);
  if (exact >= 0) return exact;
  const target = new Date(baselineDate).getTime();
  return bars.findIndex((b) => new Date(b.date).getTime() >= target);
}

async function seedEvent(event, entity, now) {
  const anchor = event.eventDate ?? event.scheduledDate;
  const anchorHasPassed = anchor && new Date(anchor).getTime() <= now.getTime();
  const pending = (event.reaction.points ?? []).filter(
    (p) =>
      p.absReturn === null &&
      p.populatesOn &&
      new Date(p.populatesOn) <= now,
  );
  const needsBaseline =
    (!event.reaction.baselineDate || event.reaction.baselineClose === null) &&
    anchorHasPassed;
  if (pending.length === 0 && !needsBaseline) return { changed: false };
  const secSymbol = entity.yahooSymbol;
  if (!secSymbol) return { changed: false, reason: "no yahoo symbol" };
  const secBars = await yahooSeries(secSymbol);
  if (secBars.length === 0) return { changed: false, reason: "no bars" };

  let baselineDate = event.reaction.baselineDate;
  let baselineClose = event.reaction.baselineClose;
  if (needsBaseline) {
    const idx = pickBaselineIdx(secBars, anchor, event.timing);
    if (idx >= 0) {
      baselineDate = secBars[idx].date;
      baselineClose = secBars[idx].close;
    }
  }
  if (!baselineDate || baselineClose === null) return { changed: false, reason: "no baseline" };
  const secBaseIdx = findBaselineIdxByDate(secBars, baselineDate);
  if (secBaseIdx < 0) return { changed: false, reason: "baseline off-range" };

  const benchSymbol = toBenchmarkSymbol(entity.benchmark);
  let benchBars = [];
  let benchBaseIdx = -1;
  if (benchSymbol) {
    benchBars = await yahooSeries(benchSymbol);
    if (benchBars.length > 0) {
      benchBaseIdx = findBaselineIdxByDate(benchBars, baselineDate);
    }
  }

  const matured = [];
  const nextPoints = (event.reaction.points ?? []).map((p) => {
    if (p.absReturn !== null) return p;
    if (!p.populatesOn || new Date(p.populatesOn) > now) return p;
    const offset = OFFSETS[p.horizon];
    const secIdx = secBaseIdx + offset;
    if (secIdx >= secBars.length) return p;
    const secClose = secBars[secIdx].close;
    const absReturn = (secClose - baselineClose) / baselineClose;
    let excessReturn = null;
    let gapFlagged = false;
    if (benchBaseIdx >= 0 && benchBars[benchBaseIdx] != null) {
      const benchIdx = benchBaseIdx + offset;
      if (benchIdx < benchBars.length) {
        const benchBase = benchBars[benchBaseIdx].close;
        const benchClose = benchBars[benchIdx].close;
        excessReturn = absReturn - (benchClose - benchBase) / benchBase;
      } else {
        gapFlagged = true;
      }
    } else {
      gapFlagged = true;
    }
    matured.push(p.horizon);
    return {
      ...p,
      absReturn,
      excessReturn,
      computedAt: now.toISOString(),
      ...(gapFlagged ? { gapFlagged: true } : {}),
    };
  });

  event.reaction.baselineDate = baselineDate;
  event.reaction.baselineClose = baselineClose;
  event.reaction.points = nextPoints;
  return { changed: true, matured };
}

async function main() {
  console.log(`seed-reaction-baselines · dry=${DRY}`);
  const [rawEarnings, rawRegistry] = await Promise.all([
    fs.readFile(EARNINGS_PATH, "utf-8"),
    fs.readFile(REGISTRY_PATH, "utf-8"),
  ]);
  const snap = JSON.parse(rawEarnings);
  const registry = JSON.parse(rawRegistry);
  const entMap = new Map(registry.entities.map((e) => [e.ticker, e]));

  const now = new Date();
  let baselineSeeded = 0;
  let horizonsMatured = 0;
  let noYahoo = 0;
  let noBars = 0;
  let noOp = 0;

  let pointsSeeded = 0;
  for (const ev of snap.events) {
    const entity = entMap.get(ev.ticker);
    if (!entity) { noOp++; continue; }
    if (entity.securityType === "etf") { noOp++; continue; }
    if (seedReactionPoints(ev)) pointsSeeded++;
    const priorBaseline = ev.reaction.baselineDate;
    const priorMatured = (ev.reaction.points ?? []).filter((p) => p.absReturn !== null).length;
    const res = await seedEvent(ev, entity, now);
    if (!res.changed) {
      if (res.reason === "no yahoo symbol") noYahoo++;
      else if (res.reason === "no bars") noBars++;
      else noOp++;
      continue;
    }
    if (!priorBaseline && ev.reaction.baselineDate) baselineSeeded++;
    horizonsMatured += (res.matured ?? []).length;
    const afterMatured = (ev.reaction.points ?? []).filter((p) => p.absReturn !== null).length;
    if (baselineSeeded <= 10 && afterMatured > priorMatured) {
      console.log(`  ${ev.ticker.padEnd(12)} ${ev.period.padEnd(12)} baseline=${ev.reaction.baselineDate} matured=[${(res.matured ?? []).join(",")}]`);
    }
  }

  console.log(`\nSeeded reaction points: ${pointsSeeded}`);
  console.log(`Seeded baselines:       ${baselineSeeded}`);
  console.log(`Matured horizons:       ${horizonsMatured}`);
  console.log(`No yahooSymbol: ${noYahoo} · no bars returned: ${noBars} · nothing to do: ${noOp}`);

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
