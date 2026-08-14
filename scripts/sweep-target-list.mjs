#!/usr/bin/env node
/**
 * Emit the /sweep target-list as a single JSON array of tickers to
 * stdout. Used by .claude/commands/sweep.md step 1.
 *
 * Default behavior: pre-filter to "reported in the last N trading
 * days" using data/events-index.json. Only tickers whose lastEventDate
 * is fresh land in the output — typically 10-50 per day, not the full
 * ~3,000 universe. This keeps Claude's turn budget bounded because it
 * only iterates through actual candidates, not the whole universe.
 *
 * Configuration knobs (env vars):
 *   SCOPE=all (default)     — universe scope (~2,985 entities pre-filter)
 *   SCOPE=indexed           — SP500 + R1000 + covered pool (~1,000)
 *   RECENT_DAYS=5 (default) — how far back "recently reported" reaches
 *   NOFILTER=1              — disable the events-index pre-filter and
 *                             emit the full candidate pool (rarely
 *                             needed — Claude will exhaust turns).
 *
 *   node scripts/sweep-target-list.mjs
 *   SCOPE=indexed node scripts/sweep-target-list.mjs
 *   NOFILTER=1 node scripts/sweep-target-list.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SCOPE = process.env.SCOPE === "indexed" ? "indexed" : "all";
const NOFILTER = process.env.NOFILTER === "1";
const RECENT_DAYS = Number(process.env.RECENT_DAYS ?? 7);
// Claude Code's --max-turns 100 (bumped from 30 on 2026-08-04) caps
// how many tickers a single /sweep run can process. 30 leaves headroom:
// ~1 setup turn + 30 resolve calls + (0.25 * 30 * 8 turns/summary) ≈
// 91 turns worst-case, well under 100. Freshest events land first so
// the most-recently-reported get summarized first; any overflow gets
// picked up on tomorrow's sweep.
const LIMIT = Number(process.env.LIMIT ?? 30);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysBack(iso, ref) {
  return Math.floor(
    (new Date(ref).getTime() - new Date(iso).getTime()) / 86_400_000,
  );
}

async function main() {
  const reg = JSON.parse(await fs.readFile(path.join(ROOT, "data", "entity-registry.json"), "utf-8"));

  // Freshness-based due list only — every earnings-reporting ticker
  // that has a report in the last RECENT_DAYS days AND lacks a summary
  // for that period is candidate. Covered-tier is NOT auto-included;
  // covered names still get processed when they actually report (the
  // freshness filter picks them up like any other ticker).
  const pool = new Set();

  // Build the CANDIDATE POOL — same universe filter both scopes share.
  // Only excludes types that structurally can't produce an earnings
  // summary: developer/ETF (not earnings-reporting) and pre-listing
  // (no historical filings). Everything else is fair game — including
  // dormant names (may still trickle a delayed filing) and foreign-
  // filer ADRs (BABA-style; report on 6-K/20-F, but /earnings can
  // still summarize when a release is present).
  for (const e of reg.entities ?? []) {
    if (e.securityType !== "operating") continue;
    if (e.secFilerType === "pre-listing") continue;

    if (SCOPE === "indexed") {
      if (!e.ticker.endsWith(" US")) continue;
      const mem = e.index_membership ?? [];
      if (mem.includes("SP500") || mem.includes("R1000")) pool.add(e.ticker);
    } else {
      pool.add(e.ticker);
    }
  }

  if (NOFILTER) {
    process.stdout.write(JSON.stringify([...pool].sort()));
    return;
  }

  // Pre-filter by lastEventDate from the events-index. Only tickers
  // that reported in the last RECENT_DAYS get through. This is the
  // exact same filter Claude would apply per-ticker in step 1 of the
  // sweep procedure — moving it here means Claude never has to iterate
  // the ~3,000 pool with resolve-earnings-target.mjs. Typical output:
  // 10-50 tickers on a normal day, peaking at 100-200 during earnings.
  let idx;
  try {
    idx = JSON.parse(await fs.readFile(path.join(ROOT, "data", "events-index.json"), "utf-8"));
  } catch {
    // No index → emit full pool as fallback (matches NOFILTER).
    process.stdout.write(JSON.stringify([...pool].sort()));
    return;
  }

  const today = todayIso();
  const byTicker = new Map((idx.entries ?? []).map((e) => [e.ticker, e]));

  // Second pre-filter: build the set of (ticker, period) pairs that
  // already have BOTH a summary file AND populated extendedMetrics
  // on their latest event. A ticker is "done" only when both are true;
  // if the summary exists but extendedMetrics is missing/empty, it
  // still needs a sweep pass to run Step 3b.
  //
  // Filename convention (per .claude/commands/earnings.md):
  //   data/summaries/<TICKER_SLUG>_<PERIOD_SLUG>.json
  // e.g. AAPL_US_FY2026_Q1.json, HBM_CN_FY2026_Q2.json
  const summariesDir = path.join(ROOT, "data", "summaries");
  let existingSummaries = new Set();
  try {
    const files = await fs.readdir(summariesDir);
    existingSummaries = new Set(
      files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)),
    );
  } catch {
    /* no summaries dir yet — proceed with empty set */
  }
  function summaryKey(ticker, period) {
    const tSlug = ticker.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
    const pSlug = (period ?? "").replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
    return `${tSlug}_${pSlug}`;
  }

  // Check per-ticker shard for populated extendedMetrics on the latest
  // event. This is the third condition (in addition to fresh + summary):
  // a ticker with a summary but empty extendedMetrics still needs work.
  async function hasPopulatedExtendedMetrics(ticker) {
    const shardPath = path.join(
      ROOT, "data", "events",
      ticker.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_") + ".json",
    );
    try {
      const shard = JSON.parse(await fs.readFile(shardPath, "utf-8"));
      const events = Array.isArray(shard) ? shard : (shard.events ?? []);
      const latest = events
        .filter((e) => e.eventDate)
        .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""))[0];
      return Array.isArray(latest?.extendedMetrics) && latest.extendedMetrics.length > 0;
    } catch {
      return false;
    }
  }

  const due = [];
  for (const t of pool) {
    const row = byTicker.get(t);
    if (!row?.lastEventDate) continue;
    const gap = daysBack(row.lastEventDate, today);
    if (gap < 0 || gap > RECENT_DAYS + 2) continue;
    const hasSummary = row.lastPeriod && existingSummaries.has(summaryKey(t, row.lastPeriod));
    const hasMetrics = await hasPopulatedExtendedMetrics(t);
    // Skip only when BOTH the summary file exists AND extendedMetrics
    // has ≥1 entry on the latest event. Missing either → include.
    if (hasSummary && hasMetrics) continue;
    due.push({ ticker: t, lastEventDate: row.lastEventDate });
  }

  // Sort freshest-first so a truncated run summarizes today's
  // and yesterday's reporters before older ones. Then apply LIMIT.
  due.sort((a, b) => b.lastEventDate.localeCompare(a.lastEventDate));
  const dueTickers = due.slice(0, LIMIT).map((d) => d.ticker);
  process.stdout.write(JSON.stringify(dueTickers.sort()));
}

main().catch((e) => { console.error(e); process.exit(1); });
