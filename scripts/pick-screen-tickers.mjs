#!/usr/bin/env node
/**
 * Feature 4B — orchestration helper for the framework-screen workflow.
 *
 * Emits the next batch of tickers for Claude to screen against a
 * given framework. Ordering strategy:
 *
 *   1. Universe = operating entities in SP500 ∪ R1000 ∪ isCore.
 *   2. Any ticker whose card in data/screens/<framework>.json is
 *      older than 45 days (or missing) is a candidate.
 *   3. Emit candidates in order of market cap desc (largest first),
 *      then ticker as tie-break. Previously used ranking composite
 *      as the primary order key; that data was removed with the
 *      pivot to sector themes, so market cap is the sole signal now.
 *
 * The workflow calls this with --limit N to fetch a batch, then
 * self-chains until this script emits an empty list (universe
 * complete for the current month).
 *
 * Usage:
 *   node scripts/pick-screen-tickers.mjs <framework> --limit N [--verbose]
 *
 * Output: one ticker per line on stdout. Empty output = universe
 * complete for this framework at the current 45-day threshold.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const [, , FRAMEWORK, ...rest] = process.argv;
if (!FRAMEWORK) {
  console.error("Usage: node scripts/pick-screen-tickers.mjs <framework> --limit N [--verbose]");
  process.exit(1);
}
const LIMIT = rest.includes("--limit")
  ? Number(rest[rest.indexOf("--limit") + 1])
  : 8;
const VERBOSE = rest.includes("--verbose");
const STALE_DAYS = 45;

async function main() {
  const reg = JSON.parse(
    await fs.readFile(path.join(ROOT, "data", "entity-registry.json"), "utf-8"),
  );
  const entities = (reg.entities ?? []).filter((e) => {
    if (!e || e.securityType !== "operating" || e.dormant) return false;
    if (e.secFilerType === "foreign" || e.secFilerType === "pre-listing") return false;
    const m = e.index_membership ?? [];
    return e.isCore || m.includes("SP500") || m.includes("R1000");
  });

  // Load existing screen — anything screened within STALE_DAYS is
  // skipped this run.
  let existing = null;
  try {
    existing = JSON.parse(
      await fs.readFile(
        path.join(ROOT, "data", "screens", `${FRAMEWORK}.json`),
        "utf-8",
      ),
    );
  } catch {
    // First-run — no existing screens → the full universe is fair game.
  }
  const cutoff = Date.now() - STALE_DAYS * 86_400_000;
  const freshByTicker = new Set(
    (existing?.screens ?? [])
      .filter((s) => new Date(s.screenedAt).getTime() >= cutoff)
      .map((s) => s.ticker),
  );

  const candidates = entities
    .filter((e) => !freshByTicker.has(e.ticker))
    .map((e) => ({
      ticker: e.ticker,
      marketCap: e.marketCapUsd ?? 0,
      displayName: e.displayName,
    }))
    .sort((a, b) => {
      if (a.marketCap !== b.marketCap) return b.marketCap - a.marketCap;
      return a.ticker.localeCompare(b.ticker);
    });

  const batch = candidates.slice(0, LIMIT);

  if (VERBOSE) {
    console.error(
      `universe: ${entities.length} · fresh (< ${STALE_DAYS}d): ${freshByTicker.size} · candidates: ${candidates.length} · batch: ${batch.length}`,
    );
    for (const b of batch) {
      console.error(
        `  ${b.ticker.padEnd(12)}  cap=$${(b.marketCap / 1e9).toFixed(1)}B  ${b.displayName}`,
      );
    }
  }

  for (const b of batch) console.log(b.ticker);
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
