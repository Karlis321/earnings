#!/usr/bin/env node
/**
 * Fire /api/summarize with { force: true } for a batch of tickers.
 * Sequential — waits for each to finish before firing the next, so
 * it respects the workflow's concurrency group (1-in-progress +
 * 1-queued for group=claude-summarize).
 *
 * Usage:
 *   CRON_SECRET=xxx SOURCE=sp500 node scripts/regenerate-summaries-batch.mjs
 *
 * Env:
 *   CRON_SECRET (required) — Bearer token for POST /api/summarize
 *   SOURCE      (default: summaries) — which pool to iterate:
 *                 - summaries: every ticker under data/summaries/
 *                 - sp500: every SP500-flagged operating entity
 *                 - r1000: every R1000-flagged operating entity
 *                 - covered: data/covered.json
 *   API_BASE    (default: https://earnings-karlis123.vercel.app)
 *   DELAY_MS    (default: 900_000 = 15 min per ticker)
 *   START_AT    (default: 0) — resume from index N (alpha-sorted)
 *   LIMIT       (default: Infinity) — cap tickers per session
 *   SKIP_IF_EXTENDED (default: 1) — skip tickers that already carry
 *                    event.extendedMetrics[] on their latest event
 *                    (idempotency: no work if it's already there)
 *
 * Purpose:
 *   Populate event.extendedMetrics[] via /earnings Step 3b for every
 *   ticker in the chosen pool. Step 3b was made mandatory in commit
 *   47d78f95; existing tickers with summaries-but-no-3b get caught by
 *   force=true regeneration. SP500 / R1000 tickers without prior
 *   summaries get their first /earnings run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const CRON_SECRET = process.env.CRON_SECRET;
const API_BASE = process.env.API_BASE ?? "https://earnings-karlis123.vercel.app";
const DELAY_MS = Number(process.env.DELAY_MS ?? 15 * 60 * 1000);
const START_AT = Number(process.env.START_AT ?? 0);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const SOURCE = process.env.SOURCE ?? "summaries"; // summaries | sp500 | r1000 | covered
const SKIP_IF_EXTENDED = process.env.SKIP_IF_EXTENDED !== "0";

if (!CRON_SECRET) {
  console.error("CRON_SECRET env var required — same value the /api/summarize route checks");
  process.exit(1);
}

function tickerFromFilename(f) {
  const stem = f.replace(/\.json$/, "");
  const parts = stem.split("_");
  return parts.slice(0, -2).join(" ");
}
function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}
async function tickersFromSource() {
  if (SOURCE === "summaries") {
    const files = (await fs.readdir(path.join(ROOT, "data", "summaries"))).filter((f) =>
      f.endsWith(".json"),
    ).sort();
    return [...new Set(files.map(tickerFromFilename))].filter(Boolean);
  }
  if (SOURCE === "covered") {
    const covered = JSON.parse(await fs.readFile(path.join(ROOT, "data", "covered.json"), "utf-8"));
    return [...(covered.tickers ?? [])].sort();
  }
  // sp500 or r1000
  //   sp500 = strict SP500 membership only (~493 tickers)
  //   r1000 = SP500 ∪ R1000 union (~1,022 unique tickers). The union
  //     matters because 9 SP500 members aren't tagged R1000 in the
  //     current registry — iterating only R1000 would miss them.
  const reg = JSON.parse(await fs.readFile(path.join(ROOT, "data", "entity-registry.json"), "utf-8"));
  return (reg.entities ?? [])
    .filter((e) => {
      const mem = e.index_membership ?? [];
      if (SOURCE === "sp500") return mem.includes("SP500");
      // r1000 = union
      return mem.includes("R1000") || mem.includes("SP500");
    })
    .filter((e) => e.securityType === "operating" && !e.dormant)
    .filter((e) => e.secFilerType !== "foreign" && e.secFilerType !== "pre-listing")
    .map((e) => e.ticker)
    .sort();
}
// Read the ticker's shard from origin/main (not the runner's local
// checkout, which is a snapshot taken at boot time and NEVER refreshes
// during the batch's 5-6h lifetime). Historical bug: as concurrent
// claude-summarize commits populated extendedMetrics on tickers the
// batch had already scanned, the running batch kept seeing the STALE
// local snapshot and re-dispatched already-populated tickers with
// force:true. Net result across 12h: 46 commits landed but only +1
// ticker was newly populated. Fetching origin/main per-check makes
// the SKIP filter respect the live state on main. `git fetch --depth=1`
// is cheap (~50ms), `git show origin/main:` reads without touching
// the working tree, and refresh_freq below throttles so we don't fetch
// on every ticker — one refresh per ~5 checks is enough for a batch
// running with 15-min dispatch delays.
let _lastFetchTs = 0;
async function refreshOriginIfStale() {
  const now = Date.now();
  if (now - _lastFetchTs < 60_000) return; // dedup within 1 min
  _lastFetchTs = now;
  try {
    const { execSync } = await import("node:child_process");
    execSync("git fetch --quiet origin main --depth=1", { cwd: ROOT });
  } catch { /* offline / no upstream — keep going with stale data */ }
}
async function alreadyHasExtended(ticker) {
  if (!SKIP_IF_EXTENDED) return false;
  await refreshOriginIfStale();
  try {
    const { execSync } = await import("node:child_process");
    const shardRel = `data/events/${tickerSlug(ticker)}.json`;
    const raw = execSync(`git show origin/main:${shardRel}`, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const shard = JSON.parse(raw);
    const events = Array.isArray(shard) ? shard : shard.events ?? [];
    const past = events.filter((e) => e.eventDate).sort((a, b) =>
      (b.eventDate ?? "").localeCompare(a.eventDate ?? ""),
    );
    const latest = past[0];
    return Array.isArray(latest?.extendedMetrics) && latest.extendedMetrics.length > 0;
  } catch {
    // Shard not on origin/main yet — treat as unpopulated so the ticker
    // gets processed (safer than skipping something we can't verify).
    return false;
  }
}

async function main() {
  const tickers = await tickersFromSource();
  console.log(`Regenerating from SOURCE=${SOURCE} · ${tickers.length} tickers · DELAY_MS=${DELAY_MS} · START_AT=${START_AT} · LIMIT=${LIMIT}`);
  console.log(`SKIP_IF_EXTENDED=${SKIP_IF_EXTENDED} (tickers with extendedMetrics on latest event will be skipped)`);
  console.log(`Estimated wall time: ${((tickers.length - START_AT) * DELAY_MS / 60000).toFixed(0)} minutes`);
  console.log();

  const end = Math.min(tickers.length, START_AT + LIMIT);
  let skipped = 0;
  for (let i = START_AT; i < end; i++) {
    const ticker = tickers[i];
    // Skip if extendedMetrics already populated on latest event.
    if (await alreadyHasExtended(ticker)) {
      console.log(`[${i + 1}/${end}] ${ticker} · SKIP (extendedMetrics already present)`);
      skipped++;
      continue;
    }
    const t0 = Date.now();
    console.log(`[${i + 1}/${end}] ${ticker} · dispatching...`);
    try {
      const r = await fetch(`${API_BASE}/api/summarize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CRON_SECRET}`,
        },
        // `force: true` is required for two independent reasons:
        //   1. Bypass the covered-tier 403 gate in /api/summarize
        //      (route.ts lines 118-129). The batch iterates the
        //      entire R1000/SP500 pool, not the 17-ticker covered
        //      set — without force, every non-covered dispatch hits
        //      403 "not-covered" and the batch effectively no-ops
        //      on ~980 of 988 tickers.
        //   2. Bypass the 409 "summary already exists" guard for the
        //      case where a summary file exists but its shard event
        //      has empty extendedMetrics (Step 3b never ran) — the
        //      historical reason this batch exists at all.
        // The re-processing loop that force previously participated in
        // was NOT caused by force itself. The bug was SKIP_IF_EXTENDED
        // reading a stale runner-local snapshot (fixed above by
        // switching that check to `git show origin/main:`). With the
        // SKIP check reading live state, already-populated tickers
        // correctly skip regardless of force being on.
        body: JSON.stringify({ ticker, force: true }),
      });
      const body = await r.json().catch(() => null);
      if (r.status === 202) {
        console.log(`  ✓ dispatched (workflow will run in the background)`);
      } else if (r.status === 429) {
        console.log(`  ⏳ rate-limited (${body?.retryAfterSec}s) — waiting`);
        await new Promise((r) => setTimeout(r, (body?.retryAfterSec ?? 60) * 1000));
        i--; // retry
        continue;
      } else {
        console.log(`  ✗ status=${r.status} · ${body?.message ?? "unknown"}`);
      }
    } catch (e) {
      console.log(`  ✗ fetch failed: ${e.message}`);
    }
    // Wait for the workflow to finish before firing the next.
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, DELAY_MS - elapsed);
    if (i + 1 < end && wait > 0) {
      console.log(`  waiting ${(wait / 1000).toFixed(0)}s before next…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  const fired = end - START_AT - skipped;
  console.log(`\nDone. Fired ${fired} dispatches · skipped ${skipped} (already have extendedMetrics).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
