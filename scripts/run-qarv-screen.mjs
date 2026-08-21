#!/usr/bin/env node
/**
 * Phase 4.4 — QARV quantitative screen (Quality / Assets /
 * Revisions / Value). Reads data/events-index.json +
 * data/entity-registry.json — no vendor calls, no shard walk — and
 * writes data/screens/qarv.json in the SAME schema as the blue-ocean
 * and rule-breaker files (one ScreenCard per ticker with 4 named
 * dimensions), so /screens?framework=qarv renders through the
 * existing ScreenTable with zero UI branching.
 *
 * Unlike the LLM-narrative frameworks (blue-ocean, rule-breaker) this
 * is fully mechanical — deterministic factor scoring from the metrics
 * already committed to events-index. Each run overwrites the whole
 * file (not a per-ticker merge) because the universe is scored in
 * one pass.
 *
 * Dimensions (each 0-100 with a short rationale string):
 *   quality     — net margin (net income ÷ revenue). Higher = higher quality earnings.
 *   assets      — capital efficiency (revenue ÷ shareholders equity).
 *                  Higher = better asset use. Equity is covered on
 *                  ~93% of the in-universe set; total-debt was on
 *                  ~5% (Yahoo shard gap), so we don't blend it in
 *                  and pay the coverage tax.
 *   revisions   — latest earnings surprise + next-quarter estimate revision
 *                  (both point in the same direction when analysts are
 *                  chasing the fundamentals).
 *   value       — P/S multiple (marketCap ÷ trailing annualized revenue).
 *                  INVERTED so lower P/S → higher score.
 *
 *   node scripts/run-qarv-screen.mjs [--top N] [--dry]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const INDEX_PATH = path.join(ROOT, "data", "events-index.json");
const OUT_PATH = path.join(ROOT, "data", "screens", "qarv.json");

const ARGS = process.argv.slice(2);
const TOP = ARGS.includes("--top")
  ? Number(ARGS[ARGS.indexOf("--top") + 1])
  : Infinity;
const DRY = ARGS.includes("--dry");

const DIMENSIONS = [
  {
    key: "quality",
    label: "Quality",
    description:
      "Net margin (net income ÷ revenue) on the latest reported period. Higher = higher-quality earnings.",
  },
  {
    key: "assets",
    label: "Assets",
    description:
      "Capital efficiency proxy: revenue ÷ shareholders equity on the latest period. Higher = more productive capital use.",
  },
  {
    key: "revisions",
    label: "Revisions",
    description:
      "Sign of the last earnings surprise combined with the forward estimate revision. Positive = analysts chasing beats upward.",
  },
  {
    key: "value",
    label: "Value",
    description:
      "Inverted P/S multiple (marketCap ÷ trailing 4-quarter revenue). Higher = cheaper on sales.",
  },
];

// Percentile → 0-100 helper. Sort-index divided by (n-1) times 100.
function percentileScore(sortedValues, v) {
  if (v == null || Number.isNaN(v)) return null;
  const n = sortedValues.length;
  if (n < 2) return null;
  // Binary search index of last value <= v
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (sortedValues[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  // Percentile = (index of v) / (n-1)
  return Number(((lo / (n - 1)) * 100).toFixed(1));
}

function safeDiv(a, b) {
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (b === 0 || Number.isNaN(a) || Number.isNaN(b)) return null;
  return a / b;
}

function inUniverse(entity) {
  if (!entity) return false;
  if (entity.securityType !== "operating") return false;
  if (entity.dormant) return false;
  if (entity.secFilerType === "foreign" || entity.secFilerType === "pre-listing")
    return false;
  const mem = entity.index_membership ?? [];
  return entity.isCore || mem.includes("SP500") || mem.includes("R1000");
}

// Extract a metric value from events-index latestMetrics; skips
// non-USD-labeled units so cross-listing distortion doesn't leak
// into the ranking (Yahoo reports Chinese ADRs in CNY, etc.).
function getUsdMetric(entry, key) {
  const m = entry?.latestMetrics?.[key];
  if (!m || typeof m.value !== "number") return null;
  const unit = (m.unit ?? "").toUpperCase();
  // Metrics are already scaled to millions (`_usd_m` suffix in the
  // events-index shape) — the unit field carries currency only.
  if (unit && unit !== "USD") return null;
  return m.value;
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

  // Pass 1 — collect raw factor values per ticker.
  const raws = [];
  for (const entry of universe) {
    const entity = byTicker.get(entry.ticker);
    const revenue = getUsdMetric(entry, "revenue_usd_m");
    const netIncome = getUsdMetric(entry, "net_income_usd_m");
    const equity = getUsdMetric(entry, "shareholders_equity_usd_m");

    // Quality: net margin (unbounded but typically −50% .. +50%).
    const quality = safeDiv(netIncome, revenue);

    // Assets: revenue / equity. Skip when denominator is
    // non-positive (distressed balance sheet — different regime).
    const assets =
      typeof equity === "number" && equity > 0
        ? safeDiv(revenue, equity)
        : null;

    // Revisions: sign of last surprise combined with forward
    // estimate revision. Both fields already computed by
    // shard-earnings — reuse.
    const surprise =
      typeof entry.lastSurprisePct === "number" ? entry.lastSurprisePct : null;
    const trend =
      typeof entry.nextEstimateVsActualPct === "number"
        ? entry.nextEstimateVsActualPct
        : null;
    const revisions =
      surprise == null && trend == null
        ? null
        : (surprise ?? 0) + (trend ?? 0);

    // Value: marketCap (USD) / trailing 4-quarter revenue. We only
    // have latest-period revenue on the index — approximate the
    // trailing 4Q by ×4 when the ticker looks quarterly, else ×1
    // for annual reporters. Rough but consistent across the universe.
    const mcap = entity?.marketCapUsd ?? null;
    const cadence = entry.nextCadence ?? "quarterly";
    const revenueAnnualized =
      typeof revenue === "number" && revenue > 0
        ? cadence === "quarterly"
          ? revenue * 4
          : revenue
        : null;
    // marketCapUsd is already in USD absolute (not millions); revenue
    // is in millions. Convert both to millions for the ratio.
    const mcapMillions = typeof mcap === "number" ? mcap / 1_000_000 : null;
    const ps =
      mcapMillions != null && revenueAnnualized != null
        ? mcapMillions / revenueAnnualized
        : null;
    // Guard against extreme outliers so the percentile sort isn't
    // dominated by 1 stub-revenue name.
    const psClean = ps != null && ps > 0 && ps < 200 ? ps : null;

    raws.push({
      ticker: entry.ticker,
      entity,
      entry,
      quality,
      assets,
      revisions,
      psInverse: psClean != null ? -psClean : null, // invert so higher = cheaper
    });
  }

  // Pass 2 — percentile-rank each factor across the universe.
  function sortedNonNull(arr, key) {
    return arr
      .map((r) => r[key])
      .filter((v) => typeof v === "number" && !Number.isNaN(v))
      .sort((a, b) => a - b);
  }
  const sortedQuality = sortedNonNull(raws, "quality");
  const sortedAssets = sortedNonNull(raws, "assets");
  const sortedRevisions = sortedNonNull(raws, "revisions");
  const sortedValue = sortedNonNull(raws, "psInverse");

  // Pass 3 — assemble ScreenCards.
  const rows = [];
  for (const r of raws) {
    const qs = percentileScore(sortedQuality, r.quality);
    const as = percentileScore(sortedAssets, r.assets);
    const rs = percentileScore(sortedRevisions, r.revisions);
    const vs = percentileScore(sortedValue, r.psInverse);
    const present = [qs, as, rs, vs].filter((s) => s != null);
    if (present.length < 3) continue; // need at least 3 of 4 factors for a stable composite
    const composite = present.reduce((s, x) => s + x, 0) / present.length;

    // Build compact rationale strings (constraint: schema requires 20-280 chars).
    const rationaleQuality =
      qs == null
        ? "no data — net-income or revenue missing on latest metric snapshot"
        : `Net margin ${((r.quality ?? 0) * 100).toFixed(1)}% on latest period · percentile ${qs.toFixed(0)} of universe`;
    const rationaleAssets =
      as == null
        ? "no data — equity missing so capital-efficiency proxy is unresolvable"
        : `Revenue ÷ equity ${(r.assets ?? 0).toFixed(2)}× · percentile ${as.toFixed(0)} of universe`;
    const rationaleRevisions =
      rs == null
        ? "no data — neither last-surprise nor forward estimate revision are populated"
        : `Last surprise + forward revision sum ${(r.revisions ?? 0).toFixed(1)}% · percentile ${rs.toFixed(0)} of universe`;
    const rationaleValue =
      vs == null
        ? "no data — marketCap or revenue missing so P/S is unresolvable"
        : `P/S ${(-r.psInverse).toFixed(1)}× (marketCap ÷ latest quarter × 4 for quarterly reporters — TTM approximation) · percentile ${vs.toFixed(0)} of universe (higher = cheaper)`;

    // Verdict — deterministic template so no LLM needed. 20-320 chars.
    const strongest =
      [
        { k: "quality", s: qs ?? -1 },
        { k: "assets", s: as ?? -1 },
        { k: "revisions", s: rs ?? -1 },
        { k: "value", s: vs ?? -1 },
      ].sort((a, b) => b.s - a.s)[0].k;
    const verdict =
      composite >= 75
        ? `Strong QARV composite across ${present.length}/4 factors — leans on ${strongest}. Composite ${composite.toFixed(0)}.`
        : composite >= 50
        ? `Mid-quintile QARV — ${strongest} is the standout factor. Composite ${composite.toFixed(0)}.`
        : `Weak QARV composite — ${strongest} is the least-weak leg. Composite ${composite.toFixed(0)}.`;

    rows.push({
      ticker: r.ticker,
      companyId: r.entity?.companyId ?? null,
      displayName: r.entity?.displayName ?? r.ticker,
      compositeScore: Number(composite.toFixed(1)),
      dimensions: [
        // Emit null (not 0) for missing factors so the UI can render
        // "—" instead of a red-zero bar next to a "no data" rationale.
        // Composite above already averaged only the present factors,
        // so nulling here doesn't affect the top-level score.
        { key: "quality", score: qs, rationale: rationaleQuality },
        { key: "assets", score: as, rationale: rationaleAssets },
        { key: "revisions", score: rs, rationale: rationaleRevisions },
        { key: "value", score: vs, rationale: rationaleValue },
      ],
      verdict,
      sources: [
        {
          kind: "shard",
          ref: `data/events-index.json · ${r.entry.lastPeriod ?? "—"}`,
        },
      ],
      screenedAt: new Date().toISOString(),
    });
  }

  rows.sort((a, b) => b.compositeScore - a.compositeScore);
  const clipped = Number.isFinite(TOP) ? rows.slice(0, TOP) : rows;

  const out = {
    schema: "screen/v1",
    framework: "qarv",
    generatedAt: new Date().toISOString(),
    dimensions: DIMENSIONS,
    screens: clipped,
  };

  console.log(
    `run-qarv-screen · universe ${universe.length} · scored ${rows.length}${Number.isFinite(TOP) ? ` · kept top ${clipped.length}` : ""}`,
  );
  if (DRY) {
    console.log("[dry] would write", OUT_PATH);
    console.log("top 5 by composite:");
    for (const r of clipped.slice(0, 5)) {
      console.log(
        `  · ${r.ticker.padEnd(12)} composite ${r.compositeScore.toFixed(0).padStart(3)}  Q${(r.dimensions[0].score ?? 0).toFixed(0).padStart(3)}  A${(r.dimensions[1].score ?? 0).toFixed(0).padStart(3)}  R${(r.dimensions[2].score ?? 0).toFixed(0).padStart(3)}  V${(r.dimensions[3].score ?? 0).toFixed(0).padStart(3)}`,
      );
    }
  } else {
    await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
    await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
    console.log(`✓ wrote data/screens/qarv.json · ${clipped.length} rows`);
  }
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
