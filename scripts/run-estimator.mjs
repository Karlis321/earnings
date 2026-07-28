#!/usr/bin/env node
/**
 * Local runner for the median-gap next-event estimator. Mirrors what
 * cron step 3c does. For each operating entity without a next-event
 * shell, projects a shell forward from the median gap between past
 * event dates.
 *
 * Shard-first: when data/earnings.json is absent (canonical case per
 * CLAUDE.md) the runner reconstitutes past events from data/events/*.json
 * shards and writes new shells straight back into the per-ticker shard
 * (creating the shard file if missing). The monolith is only written when
 * it already exists.
 *
 *   node scripts/run-estimator.mjs         # write
 *   node scripts/run-estimator.mjs --dry
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EARNINGS = path.join(ROOT, "data", "earnings.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");

// Same slug rule as scripts/shard-earnings.mjs — must stay in sync so
// shard reads/writes hit the same file.
function tickerSlug(ticker) {
  return ticker.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}

async function loadSnapshot() {
  try {
    const raw = await fs.readFile(EARNINGS, "utf-8");
    return { snap: JSON.parse(raw), fromMonolith: true };
  } catch {
    // Reconstitute from shards.
    let files;
    try {
      files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
    } catch {
      return { snap: { events: [] }, fromMonolith: false };
    }
    const events = [];
    for (const f of files) {
      const j = JSON.parse(await fs.readFile(path.join(EVENTS_DIR, f), "utf-8"));
      const evs = Array.isArray(j) ? j : j.events ?? [];
      for (const ev of evs) events.push(ev);
    }
    return { snap: { schema: "earnings/v1", events }, fromMonolith: false };
  }
}

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;

// Kept in sync with frontend/server/lib/estimateNextEvent.ts. The cron
// path imports that TS module directly; this runner is a pure-JS mirror
// for local one-off use, so the classifier is duplicated here on purpose.
const ESTIMATE_MIN_PAST = 2;
const ESTIMATE_MAX_LOOKBACK_DAYS = 540;
const ANCHORS = { quarterly: 91, semiannual: 182, annual: 365 };

const HORIZONS = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS = { d1: 1, d3: 3, w1: 5, m1: 21 };

function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[m - 1] + s[m]) / 2) : s[m];
}
function periodFromDate(iso) {
  const d = new Date(iso);
  return { year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1 };
}
function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}

function classifyGap(days) {
  const options = [
    { c: "quarterly", d: Math.abs(days - ANCHORS.quarterly), tol: 45 },
    { c: "semiannual", d: Math.abs(days - ANCHORS.semiannual), tol: 55 },
    { c: "annual", d: Math.abs(days - ANCHORS.annual), tol: 90 },
  ].sort((a, b) => a.d - b.d);
  return options[0].d <= options[0].tol ? options[0].c : "unknown";
}
function modalCadence(classes) {
  const counts = new Map();
  for (const c of classes) counts.set(c, (counts.get(c) ?? 0) + 1);
  const known = ["quarterly", "semiannual", "annual"]
    .map((c) => ({ c, n: counts.get(c) ?? 0 }))
    .sort((a, b) => b.n - a.n);
  return known[0].n > 0 ? known[0].c : "unknown";
}

function incrementPeriod(label, cadence) {
  const m = /FY\s*(\d{4})\s+Q\s*(\d)/i.exec(label ?? "");
  if (!m) return null;
  let year = Number(m[1]);
  let q = Number(m[2]);
  const stepQ =
    cadence === "quarterly" ? 1 :
    cadence === "semiannual" ? 2 :
    cadence === "annual" ? 4 : 1;
  q += stepQ;
  while (q > 4) { q -= 4; year++; }
  return `FY${year} Q${q}`;
}

function estimate(pastDates, now, latestPastPeriod) {
  if (pastDates.length < ESTIMATE_MIN_PAST) return null;
  const sortedISO = pastDates.slice().sort();
  const latest = sortedISO[sortedISO.length - 1];
  const daysSince = (now.getTime() - new Date(latest).getTime()) / 86_400_000;
  if (daysSince > ESTIMATE_MAX_LOOKBACK_DAYS) return null;
  const gaps = [];
  for (let i = 1; i < sortedISO.length; i++) {
    const gap =
      (new Date(sortedISO[i]).getTime() -
        new Date(sortedISO[i - 1]).getTime()) /
      86_400_000;
    if (gap >= 30 && gap <= 500) gaps.push(gap);
  }
  if (!gaps.length) return null;
  const cadence = modalCadence(gaps.map(classifyGap));
  if (cadence === "unknown") return null;
  const step = ANCHORS[cadence];
  const projected = new Date(latest);
  projected.setDate(projected.getDate() + step);
  let daysAhead = (projected.getTime() - now.getTime()) / 86_400_000;
  let safety = 0;
  while (daysAhead < 0 && safety < 4) {
    projected.setDate(projected.getDate() + step);
    daysAhead = (projected.getTime() - now.getTime()) / 86_400_000;
    safety++;
  }
  // Increment the source-reported period label along the entity's own
  // fiscal calendar. MSFT / AAPL / NVDA and every non-calendar-year
  // filer are wrong under the old date-derived label.
  const period =
    latestPastPeriod ? incrementPeriod(latestPastPeriod, cadence) : null;
  return {
    scheduledDate: projected.toISOString().slice(0, 10),
    medianGap: median(gaps),
    cadence,
    period,
  };
}

async function main() {
  console.log(`run-estimator · dry=${DRY}`);
  const { snap, fromMonolith } = await loadSnapshot();
  console.log(`Source: ${fromMonolith ? "monolith" : "shards"}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const byTicker = new Map(reg.entities.map((e) => [e.ticker, e]));

  const pastByTicker = new Map();
  // Also track the latest-known fiscal-period LABEL per ticker so the
  // estimator can increment from it (Sweep 1 fix — MSFT / AAPL / NVDA
  // etc. had wrong labels because the old code derived from calendar-
  // quarter of the projected date).
  const latestPeriodByTicker = new Map();
  for (const ev of snap.events) {
    if (!ev.eventDate) continue;
    if (!pastByTicker.has(ev.ticker)) pastByTicker.set(ev.ticker, []);
    pastByTicker.get(ev.ticker).push(ev.eventDate);
    const prev = latestPeriodByTicker.get(ev.ticker);
    if (!prev || ev.eventDate > prev.date) {
      latestPeriodByTicker.set(ev.ticker, { date: ev.eventDate, period: ev.period });
    }
  }
  const shellByTicker = new Set(snap.events.filter((ev) => !ev.eventDate).map((ev) => ev.ticker));

  const now = new Date();
  let estimated = 0;
  const byCadence = { quarterly: 0, semiannual: 0, annual: 0 };
  let skipped = { noEntity: 0, hasShell: 0, notOperating: 0, failed: 0 };

  for (const [ticker, past] of pastByTicker) {
    const entity = byTicker.get(ticker);
    if (!entity) { skipped.noEntity++; continue; }
    if (entity.securityType !== "operating") { skipped.notOperating++; continue; }
    if (shellByTicker.has(ticker)) { skipped.hasShell++; continue; }
    const latestPeriod = latestPeriodByTicker.get(ticker)?.period;
    const est = estimate(past, now, latestPeriod);
    if (!est) { skipped.failed++; continue; }
    // Prefer the source-reported label incremented by cadence; fall back
    // to calendar-quarter derivation when no source label was known.
    let period = est.period;
    if (!period) {
      const { year, quarter } = periodFromDate(est.scheduledDate);
      period = `FY${year} Q${quarter}`;
    }
    const id = hashId(`${ticker}_${est.scheduledDate}_${period}`);
    const shell = {
      id,
      ticker,
      kind: "earnings",
      period,
      scheduledDate: est.scheduledDate,
      eventDate: null,
      timing: null,
      expectation: "unset",
      guidanceMove: null,
      freshness: "stale",
      provenance: "estimator-median-gap",
      provenanceAsOf: new Date().toISOString(),
      cadence: est.cadence,
      metrics: [],
      guidance: [],
      reaction: {
        benchmark: entity.benchmark ?? "",
        baselineDate: null,
        baselineClose: null,
        points: HORIZONS.map((h) => ({
          horizon: h,
          absReturn: null,
          excessReturn: null,
          benchmark: entity.benchmark ?? "",
          computedAt: null,
          populatesOn: addDays(est.scheduledDate, HORIZON_TRADING_DAYS[h] + 2),
        })),
      },
      sources: {
        windowStart: addDays(est.scheduledDate, -2),
        windowEnd: addDays(est.scheduledDate, 35),
        capturedAt: null,
        items: [],
        engineStatus: [],
      },
    };
    snap.events.push(shell);
    estimated++;
    byCadence[est.cadence] = (byCadence[est.cadence] ?? 0) + 1;
  }

  console.log(`\nEstimated shells added:  ${estimated}`);
  console.log(`  quarterly:   ${byCadence.quarterly}`);
  console.log(`  semiannual:  ${byCadence.semiannual}`);
  console.log(`  annual:      ${byCadence.annual}`);
  console.log(`Skipped:`);
  console.log(`  entity not in registry:   ${skipped.noEntity}`);
  console.log(`  already has next shell:   ${skipped.hasShell}`);
  console.log(`  not operating (dev/etf):  ${skipped.notOperating}`);
  console.log(`  estimator returned null:  ${skipped.failed}`);
  console.log(`\nTotal events now: ${snap.events.length}`);

  if (DRY) { console.log("Dry run — no write."); return; }

  // Write shells into per-ticker shards. This is the shard-first path and
  // stays correct regardless of whether the monolith exists locally.
  const shellsByTicker = new Map();
  for (const ev of snap.events) {
    if (ev.provenance !== "estimator-median-gap") continue;
    if (!shellsByTicker.has(ev.ticker)) shellsByTicker.set(ev.ticker, []);
    shellsByTicker.get(ev.ticker).push(ev);
  }
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  let shardsWritten = 0;
  for (const [ticker, allShellsForTicker] of shellsByTicker) {
    // Only touch shards where we just added a shell. Detect via id + freshness.
    const slug = tickerSlug(ticker);
    const shardPath = path.join(EVENTS_DIR, `${slug}.json`);
    let existing;
    try {
      const raw = await fs.readFile(shardPath, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      existing = { schema: "events-shard/v1", ticker, events: [] };
    }
    const shardEvents = Array.isArray(existing) ? existing : existing.events ?? [];
    const existingIds = new Set(shardEvents.map((e) => e.id));
    let dirty = false;
    for (const shell of allShellsForTicker) {
      if (!existingIds.has(shell.id)) {
        shardEvents.push(shell);
        dirty = true;
      }
    }
    if (dirty) {
      const body = Array.isArray(existing)
        ? shardEvents
        : { ...existing, ticker, events: shardEvents };
      await fs.writeFile(shardPath, JSON.stringify(body, null, 2));
      shardsWritten++;
    }
  }
  console.log(`✓ wrote ${shardsWritten} shard(s) with new estimator shells`);

  if (fromMonolith) {
    await fs.writeFile(EARNINGS, JSON.stringify(snap, null, 2));
    console.log(`✓ also updated ${EARNINGS}`);
  } else {
    console.log("(earnings.json absent — shards are canonical, skipping.)");
    console.log("Re-run scripts/shard-earnings.mjs to refresh events-index.json.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
