#!/usr/bin/env node
/**
 * Full-universe staleness detection. For every operating entity
 * (excluding ETFs and dormant), classify the newest earnings state
 * against what should exist by now:
 *   FRESH        latest past event covers the most recent expected period
 *   STALE        expected report date has passed (>5 trading days) but
 *                no past event for that period exists
 *   SHELL-ONLY   the period exists as a past event but with no metric.actual
 *   NO-HISTORY   the ticker has zero past events
 *   UNKNOWN      no cadence/expectation derivable
 *
 * Pure local — reads shards + registry, no network. Writes
 * scripts/audits/staleness-<YYYY-MM-DD>.json and prints a summary
 * table.
 *
 *   node scripts/detect-stale-earnings.mjs
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

const TODAY = new Date();
const TODAY_ISO = TODAY.toISOString().slice(0, 10);
const OUT_FILE = path.join(OUT_DIR, `staleness-${TODAY_ISO}.json`);

// A report date more than 5 trading days (~7 calendar days) in the
// past without a matching filing is stale.
const STALE_THRESHOLD_DAYS = 7;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

function medianGapDays(sortedDatesIso) {
  if (sortedDatesIso.length < 2) return null;
  const ts = sortedDatesIso.map((d) => new Date(d).getTime()).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 86_400_000);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

// Load one shard, return past-with-real-eventDate + past-shell + upcoming.
function loadShard(ticker) {
  const p = path.join(EVENTS_DIR, tickerSlug(ticker) + ".json");
  try {
    const j = JSON.parse(fssync.readFileSync(p, "utf-8"));
    const events = Array.isArray(j) ? j : j.events ?? [];
    const past = events
      .filter((e) => e.eventDate)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
    const upcoming = events
      .filter((e) => !e.eventDate)
      .sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
    return { events, past, upcoming, exists: true };
  } catch {
    return { events: [], past: [], upcoming: [], exists: false };
  }
}

function hasRealActuals(event) {
  return (event.metrics ?? []).some((m) => m.actual?.value != null);
}

function nextQuarterLabel(period) {
  const m = /^FY(\d{4})\s*Q([1-4])$/.exec(period ?? "");
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]);
  return q === 4 ? `FY${y + 1} Q1` : `FY${y} Q${q + 1}`;
}

function daysBetween(a, b) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).filter(
    (e) => e.securityType === "operating" && e.dormant !== true,
  );

  const counts = { FRESH: 0, STALE: 0, "SHELL-ONLY": 0, "NO-HISTORY": 0, UNKNOWN: 0 };
  const perTicker = [];

  for (const entity of entities) {
    const shard = loadShard(entity.ticker);
    const pastReal = shard.past.filter(hasRealActuals);
    const pastAny = shard.past;

    // NO-HISTORY: zero past events on the shard.
    if (pastAny.length === 0) {
      counts["NO-HISTORY"]++;
      perTicker.push({ ticker: entity.ticker, class: "NO-HISTORY", reason: "no past events at all" });
      continue;
    }

    // Compute cadence from real past eventDates.
    const pastDatesReal = pastReal.map((e) => e.eventDate).filter(Boolean).sort();
    const pastDatesAny = pastAny.map((e) => e.eventDate).filter(Boolean).sort();
    const cadence = medianGapDays(pastDatesReal.length >= 2 ? pastDatesReal : pastDatesAny);

    // Anchor for expected next report:
    //   latest real past event date + cadence (if cadence known).
    const latestRealPast = pastReal[0] ?? null;
    const latestAnyPast = pastAny[0];
    const anchorPast = latestRealPast?.eventDate ?? latestAnyPast?.eventDate ?? null;

    if (!cadence || !anchorPast) {
      counts.UNKNOWN++;
      perTicker.push({
        ticker: entity.ticker,
        class: "UNKNOWN",
        reason: `cadence=${cadence} anchor=${anchorPast}`,
        latestPastPeriod: latestAnyPast?.period ?? null,
        latestPastDate: latestAnyPast?.eventDate ?? null,
      });
      continue;
    }

    // Expected next report — prefer an upcoming shell's scheduledDate
    // (Yahoo's calendar is more reliable for fiscal-offset issuers than
    // last-real + median-cadence, which projects too early for AAPL/
    // NVDA/WMT etc). Fall back to cadence when there's no shell.
    const upcomingShellIso = shard.upcoming[0]?.scheduledDate ?? null;
    const cadenceProjectedTs = new Date(anchorPast).getTime() + cadence * 86_400_000;
    const cadenceProjectedIso = new Date(cadenceProjectedTs).toISOString().slice(0, 10);
    const expectedIso = upcomingShellIso ?? cadenceProjectedIso;
    const daysPastExpected = daysBetween(expectedIso, TODAY_ISO);
    const expectedPeriod = shard.upcoming[0]?.period ?? nextQuarterLabel(latestAnyPast.period);

    // SHELL-ONLY: latest past event has eventDate but no actual metrics.
    // (Or the expected next period exists as a shell — no actual.)
    const latestPastIsShell = pastAny[0] && !hasRealActuals(pastAny[0]);
    if (latestPastIsShell) {
      counts["SHELL-ONLY"]++;
      perTicker.push({
        ticker: entity.ticker,
        class: "SHELL-ONLY",
        latestPastPeriod: latestAnyPast.period,
        latestPastDate: latestAnyPast.eventDate,
        expectedPeriod,
        expectedDate: expectedIso,
        reason: "latest past event has no metric.actual — shell only",
      });
      continue;
    }

    // FRESH: the expected next report hasn't come yet (still >-7 days) OR
    // we already have a past event covering the expected period.
    const alreadyHaveExpected = expectedPeriod && pastReal.some((e) => e.period === expectedPeriod);
    if (alreadyHaveExpected) {
      counts.FRESH++;
      perTicker.push({
        ticker: entity.ticker,
        class: "FRESH",
        latestPastPeriod: latestRealPast.period,
        latestPastDate: latestRealPast.eventDate,
      });
      continue;
    }
    if (daysPastExpected < STALE_THRESHOLD_DAYS) {
      counts.FRESH++;
      perTicker.push({
        ticker: entity.ticker,
        class: "FRESH",
        latestPastPeriod: latestRealPast?.period ?? latestAnyPast.period,
        latestPastDate: latestRealPast?.eventDate ?? latestAnyPast.eventDate,
        expectedPeriod,
        expectedDate: expectedIso,
        daysPastExpected,
      });
      continue;
    }

    // STALE: expected report date has passed >7 days but no past event
    // for that period.
    counts.STALE++;
    perTicker.push({
      ticker: entity.ticker,
      class: "STALE",
      yahooSymbol: entity.yahooSymbol ?? null,
      edgarCik: entity.edgarCik ?? null,
      marketCapUsd: entity.marketCapUsd ?? null,
      latestPastPeriod: latestRealPast?.period ?? latestAnyPast.period,
      latestPastDate: latestRealPast?.eventDate ?? latestAnyPast.eventDate,
      expectedPeriod,
      expectedDate: expectedIso,
      daysPastExpected,
      cadenceDays: Math.round(cadence),
    });
  }

  const total = entities.length;
  const table = Object.entries(counts).map(([k, v]) => ({ class: k, count: v, pct: ((v / total) * 100).toFixed(1) + "%" }));

  console.log("=== staleness detection " + TODAY_ISO + " ===");
  console.log(`Universe (operating, non-dormant): ${total}`);
  console.log("─".repeat(50));
  console.log("class          count  share");
  for (const r of table) console.log(`  ${r.class.padEnd(12)} ${String(r.count).padStart(5)}  ${r.pct.padStart(6)}`);
  console.log("─".repeat(50));

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    OUT_FILE,
    JSON.stringify({
      schema: "staleness/v1",
      generatedAt: new Date().toISOString(),
      today: TODAY_ISO,
      universeCount: total,
      counts,
      perTicker,
    }, null, 2),
  );
  console.log(`\n✓ full list → scripts/audits/staleness-${TODAY_ISO}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
