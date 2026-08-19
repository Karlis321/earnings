#!/usr/bin/env node
/**
 * Feature 3A — signal ranking over the ~1,600-ticker universe.
 *
 * Reads data/events-index.json + data/entity-registry.json (nothing
 * else — no vendor calls, no shard walk), computes a per-ticker
 * composite score from three components, and writes the sorted list
 * to data/ranking.json. Consumed by the (future) Ideas view; also
 * usable directly by any downstream script needing a leaderboard.
 *
 * Composite score = weighted mean of three normalized components:
 *   1. reaction — market response to the last print
 *      (lastEventReactionPoints.d3.excessReturn if present, else
 *      absReturn; scaled by tanh so extreme moves don't dominate).
 *   2. surprise — analyst beat/miss on the last print
 *      (lastSurprisePct, tanh-scaled).
 *   3. trend — forward growth signal (nextEstimateVsActualPct,
 *      tanh-scaled), added to the index by shard-earnings.mjs.
 *
 * Component weights are equal by default (0.34 / 0.33 / 0.33). If
 * a component is missing on a ticker, the row is scored against the
 * two it has and the weights re-normalize — no zero-imputation.
 *
 * Universe:
 *   - operating entities in SP500 ∪ R1000 ∪ isCore (matches the
 *     dashboard's default listing scope from earlier this session).
 *   - excludes dormant + foreign + pre-listing entities so the
 *     leaderboard is browseable + tradeable.
 *
 * Usage:
 *   node scripts/run-ranking.mjs [--top N] [--verbose]
 *   node scripts/run-ranking.mjs --sort reaction
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const INDEX_PATH = path.join(ROOT, "data", "events-index.json");
const OUT_PATH = path.join(ROOT, "data", "ranking.json");

const ARGS = process.argv.slice(2);
const TOP =
  ARGS.includes("--top")
    ? Number(ARGS[ARGS.indexOf("--top") + 1])
    : Infinity;
const VERBOSE = ARGS.includes("--verbose");
const SORT = ARGS.includes("--sort")
  ? ARGS[ARGS.indexOf("--sort") + 1]
  : "composite";

// tanh — squashes an unbounded raw value into [-1, 1]. Scale factor
// picks the point where |raw| == scale maps to ~0.76 (meaningful but
// not saturated). Different for each component because their natural
// magnitudes differ.
const SCALE = {
  reaction: 0.05, // 5% move maps to ~0.76 — a big single-day print
  surprise: 15, // 15% beat maps to ~0.76 — a large earnings surprise
  trend: 10, // 10% next-quarter growth maps to ~0.76
};
function tanhScale(raw, scale) {
  if (raw == null || Number.isNaN(raw)) return null;
  const v = raw / scale;
  return Math.tanh(v);
}

function pickReactionRaw(entry) {
  // Prefer excessReturn (alpha vs benchmark) — measures the print's
  // own signal net of market drift. Fall back to absReturn when the
  // benchmark side is unavailable. d3 horizon is the standard
  // trader-surprise window (see WatchlistTable's own d3-based
  // "reaction" column).
  const pts = entry?.lastEventReactionPoints ?? [];
  const d3 = pts.find((p) => p.horizon === "d3");
  if (!d3) return null;
  if (typeof d3.excessReturn === "number") return d3.excessReturn;
  if (typeof d3.absReturn === "number") return d3.absReturn;
  return null;
}

function inUniverse(entity) {
  if (!entity) return false;
  if (entity.securityType !== "operating") return false;
  if (entity.dormant) return false;
  if (
    entity.secFilerType === "foreign" ||
    entity.secFilerType === "pre-listing"
  )
    return false;
  const mem = entity.index_membership ?? [];
  return entity.isCore || mem.includes("SP500") || mem.includes("R1000");
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const idx = JSON.parse(await fs.readFile(INDEX_PATH, "utf-8"));
  const entities = reg.entities ?? [];
  const byTicker = new Map(entities.map((e) => [e.ticker, e]));

  const universe = (idx.entries ?? []).filter((e) => {
    const ent = byTicker.get(e.ticker);
    return inUniverse(ent);
  });

  const rows = [];
  const stats = {
    total: universe.length,
    scored: 0,
    dropped: 0,
    hasReaction: 0,
    hasSurprise: 0,
    hasTrend: 0,
    hasAllThree: 0,
  };

  for (const entry of universe) {
    const entity = byTicker.get(entry.ticker);
    const reactionRaw = pickReactionRaw(entry);
    const surpriseRaw =
      typeof entry.lastSurprisePct === "number" ? entry.lastSurprisePct : null;
    const trendRaw =
      typeof entry.nextEstimateVsActualPct === "number"
        ? entry.nextEstimateVsActualPct
        : null;

    const reaction = tanhScale(reactionRaw, SCALE.reaction);
    const surprise = tanhScale(surpriseRaw, SCALE.surprise);
    const trend = tanhScale(trendRaw, SCALE.trend);

    if (reaction != null) stats.hasReaction++;
    if (surprise != null) stats.hasSurprise++;
    if (trend != null) stats.hasTrend++;
    if (reaction != null && surprise != null && trend != null)
      stats.hasAllThree++;

    // Weighted mean over the components we DO have. Row is dropped
    // only if all three are missing.
    const present = [];
    if (reaction != null) present.push({ w: 1, v: reaction });
    if (surprise != null) present.push({ w: 1, v: surprise });
    if (trend != null) present.push({ w: 1, v: trend });
    if (present.length === 0) {
      stats.dropped++;
      continue;
    }
    const wSum = present.reduce((s, x) => s + x.w, 0);
    const composite = present.reduce((s, x) => s + x.w * x.v, 0) / wSum;
    stats.scored++;

    rows.push({
      ticker: entry.ticker,
      companyId: entity?.companyId ?? null,
      displayName: entity?.displayName ?? entry.ticker,
      capTier: entity?.capTier ?? "unknown",
      marketCapUsd: entity?.marketCapUsd ?? null,
      compositeScore: Number(composite.toFixed(4)),
      componentsPresent: present.length,
      components: {
        reaction:
          reaction == null
            ? null
            : {
                score: Number(reaction.toFixed(4)),
                raw: Number((reactionRaw * 100).toFixed(2)),
                horizon: "d3",
              },
        surprise:
          surprise == null
            ? null
            : {
                score: Number(surprise.toFixed(4)),
                raw: Number(surpriseRaw.toFixed(2)),
              },
        trend:
          trend == null
            ? null
            : {
                score: Number(trend.toFixed(4)),
                raw: Number(trendRaw.toFixed(2)),
                basis: entry.nextEstimateBasis ?? null,
              },
      },
      lastPeriod: entry.lastPeriod ?? null,
      lastEventDate: entry.lastEventDate ?? null,
      nextScheduled: entry.nextScheduled ?? null,
    });
  }

  const sortKey =
    SORT === "reaction"
      ? (r) => r.components.reaction?.score ?? -Infinity
      : SORT === "surprise"
      ? (r) => r.components.surprise?.score ?? -Infinity
      : SORT === "trend"
      ? (r) => r.components.trend?.score ?? -Infinity
      : (r) => r.compositeScore;

  rows.sort((a, b) => sortKey(b) - sortKey(a));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  const out = {
    schema: "ranking/v1",
    generatedAt: new Date().toISOString(),
    universe: "sp500∪r1000∪isCore-operating",
    weights: { reaction: 1, surprise: 1, trend: 1 },
    scales: SCALE,
    stats,
    rows: TOP === Infinity ? rows : rows.slice(0, TOP),
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`✓ wrote data/ranking.json`);
  console.log(`  universe: ${stats.total} tickers`);
  console.log(`  scored:   ${stats.scored} (${((stats.scored / stats.total) * 100).toFixed(1)}%)`);
  console.log(`  dropped:  ${stats.dropped} (no components populated)`);
  console.log(`  full coverage (all 3 components): ${stats.hasAllThree}`);
  console.log(`  reaction: ${stats.hasReaction} · surprise: ${stats.hasSurprise} · trend: ${stats.hasTrend}`);

  if (VERBOSE) {
    console.log(`\nTop 10 (sort=${SORT}):`);
    for (const r of rows.slice(0, 10)) {
      const c = r.components;
      console.log(
        `  #${String(r.rank).padStart(3, " ")}  ${r.ticker.padEnd(10)}  ` +
          `composite=${r.compositeScore.toFixed(3)}  ` +
          `[R:${c.reaction ? c.reaction.raw.toFixed(1) + "%" : "—"} ` +
          `S:${c.surprise ? c.surprise.raw.toFixed(1) + "%" : "—"} ` +
          `T:${c.trend ? c.trend.raw.toFixed(1) + "%" : "—"}]  ` +
          r.displayName.slice(0, 32),
      );
    }
  }
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
