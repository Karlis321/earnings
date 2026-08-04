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
  const reg = JSON.parse(await fs.readFile(path.join(ROOT, "data", "entity-registry.json"), "utf-8"));
  const flag = SOURCE === "sp500" ? "SP500" : "R1000";
  return (reg.entities ?? [])
    .filter((e) => (e.index_membership ?? []).includes(flag))
    .filter((e) => e.securityType === "operating" && !e.dormant)
    .filter((e) => e.secFilerType !== "foreign" && e.secFilerType !== "pre-listing")
    .map((e) => e.ticker)
    .sort();
}
async function alreadyHasExtended(ticker) {
  if (!SKIP_IF_EXTENDED) return false;
  try {
    const shard = JSON.parse(await fs.readFile(
      path.join(ROOT, "data", "events", tickerSlug(ticker) + ".json"),
      "utf-8",
    ));
    const events = Array.isArray(shard) ? shard : shard.events ?? [];
    const past = events.filter((e) => e.eventDate).sort((a, b) =>
      (b.eventDate ?? "").localeCompare(a.eventDate ?? ""),
    );
    const latest = past[0];
    return Array.isArray(latest?.extendedMetrics) && latest.extendedMetrics.length > 0;
  } catch {
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
