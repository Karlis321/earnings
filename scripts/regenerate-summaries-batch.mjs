#!/usr/bin/env node
/**
 * Fire /api/summarize with { force: true } for every summary in
 * data/summaries/. Sequential — waits for each to finish before
 * firing the next, so it respects the workflow's concurrency group
 * (1-in-progress + 1-queued for group=claude-summarize).
 *
 * Usage:
 *   CRON_SECRET=xxx node scripts/regenerate-summaries-batch.mjs
 *
 * Env:
 *   CRON_SECRET (required) — Bearer token for POST /api/summarize
 *   API_BASE (default: https://earnings-karlis123.vercel.app)
 *   DELAY_MS (default: 900_000 = 15 min per ticker)
 *   START_AT (default: 0) — resume from index N (per alpha-sorted list)
 *   LIMIT (default: Infinity) — max tickers to process this session
 *
 * Purpose:
 *   /sweep + /earnings Step 3b (extendedMetrics extraction) is now
 *   mandatory in the prompt as of commit 47d78f95. But the 57
 *   summaries that landed earlier today did NOT run 3b — their
 *   events lack extendedMetrics. Force-regenerating them re-runs
 *   /earnings with force=true, which does Step 3b and populates
 *   event.extendedMetrics[]. The summary file itself gets rewritten
 *   too but with equivalent content (regeneration is idempotent for
 *   summaries; the win is the sector metrics on the event).
 *
 * Total runtime for 57 tickers at 15 min each: ~14 hours. Runs in
 * the background; safe to Ctrl-C and resume with START_AT.
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

if (!CRON_SECRET) {
  console.error("CRON_SECRET env var required — same value the /api/summarize route checks");
  process.exit(1);
}

function tickerFromFilename(f) {
  // "AAPL_US_FY2026_Q1.json" → "AAPL US"
  const stem = f.replace(/\.json$/, "");
  const parts = stem.split("_");
  // Last two components are FYyyyy Qn
  return parts.slice(0, -2).join(" ");
}

async function main() {
  const files = (await fs.readdir(path.join(ROOT, "data", "summaries"))).filter((f) =>
    f.endsWith(".json"),
  ).sort();
  const tickers = [...new Set(files.map(tickerFromFilename))].filter(Boolean);
  console.log(`Regenerating ${tickers.length} summaries · DELAY_MS=${DELAY_MS} · START_AT=${START_AT} · LIMIT=${LIMIT}`);
  console.log(`Estimated wall time: ${((tickers.length - START_AT) * DELAY_MS / 60000).toFixed(0)} minutes`);
  console.log();

  const end = Math.min(tickers.length, START_AT + LIMIT);
  for (let i = START_AT; i < end; i++) {
    const ticker = tickers[i];
    const t0 = Date.now();
    console.log(`[${i + 1}/${end}] ${ticker} · dispatching...`);
    try {
      const r = await fetch(`${API_BASE}/api/summarize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CRON_SECRET}`,
        },
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
  console.log(`\nDone. Fired dispatches for ${end - START_AT} tickers.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
