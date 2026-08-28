#!/usr/bin/env node
/**
 * Mechanical composite-ranking pass over the SP500 ∪ R1000 ∪ isCore
 * universe. Reads `data/events-index.json` + `data/entity-registry.json`,
 * writes `data/ranking.json`.
 *
 * V1 SCORING (deliberately explainable, not a black box):
 *   reactionScore = min(|d3.absReturn|, 0.50) / 0.50            // 0..1
 *   surpriseScore = min(|lastSurprisePct| / 100, 0.30) / 0.30   // 0..1
 *   composite     = 0.55 * reactionScore + 0.45 * surpriseScore  // 0..1
 *
 * Both component scores and the composite land on the row, so the
 * consuming view can display them and the user can defend any given
 * ranking by pointing at the raw inputs.
 *
 * WHAT'S NOT HERE (deliberate):
 *   • Estimate revision — needs a new field on events-index or a
 *     shard-scan pass. Deferred to a follow-up that touches
 *     `shard-earnings.mjs`.
 *   • Momentum — needs latest close price. Deferred until we
 *     land a close-price field on events-index.
 *
 * FILTERS:
 *   • displayable (isDisplayable predicate mirrored inline)
 *   • securityType === "operating"
 *   • isCore OR SP500 OR R1000 index membership
 *   • event.lastEventDate within 90 days
 *   • matured d3 reaction OR non-null lastSurprisePct (needs one)
 *   • split-artifact guard identical to MoversStrip on `/`
 *
 * Output cap: 200 rows.
 *
 *   node scripts/run-ranking.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const IDX_PATH = path.join(ROOT, "data", "events-index.json");
const OUT_PATH = path.join(ROOT, "data", "ranking.json");

const WINDOW_DAYS = 90;
const REACTION_CAP = 0.5;
const SURPRISE_CAP_PCT = 30;
const SPLIT_DIVERGENCE_PP = 0.3;
const OUTPUT_CAP = 200;

const W_REACTION = 0.55;
const W_SURPRISE = 0.45;

// Same isDisplayable predicate the UI uses — inline mirror so this
// script doesn't take a frontend/lib import.
function isDisplayable(e) {
  if (!e) return false;
  if (e.dormant) return false;
  if (e.securityType === "etf") return false;
  return true;
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const idx = JSON.parse(await fs.readFile(IDX_PATH, "utf-8"));
  const byTicker = new Map((reg.entities ?? []).map((e) => [e.ticker, e]));

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - WINDOW_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const rows = [];
  let filteredSplit = 0;
  for (const entry of idx.entries ?? []) {
    if (!entry.lastEventDate || entry.lastEventDate < cutoffIso) continue;
    const ent = byTicker.get(entry.ticker);
    if (!ent) continue;
    if (!isDisplayable(ent)) continue;
    if (ent.securityType !== "operating") continue;
    const mem = ent.index_membership ?? [];
    if (!ent.isCore && !mem.includes("SP500") && !mem.includes("R1000")) continue;

    const points = entry.lastEventReactionPoints ?? [];
    const d1 = points.find((p) => p.horizon === "d1" && p.absReturn != null);
    const d3 = points.find((p) => p.horizon === "d3" && p.absReturn != null);
    // Split-artifact guard identical to MoversStrip.
    if (d3 && d1 && d1.absReturn != null) {
      const gap = Math.abs(d3.absReturn - d1.absReturn);
      if (gap > SPLIT_DIVERGENCE_PP && Math.abs(d1.absReturn) < 0.25) {
        filteredSplit++;
        continue;
      }
    }

    const reactionAbs = d3?.absReturn != null ? Math.abs(d3.absReturn) : null;
    const surprisePctAbs = entry.lastSurprisePct != null ? Math.abs(entry.lastSurprisePct) : null;
    if (reactionAbs == null && surprisePctAbs == null) continue;

    const reactionScore = reactionAbs == null
      ? 0
      : Math.min(reactionAbs, REACTION_CAP) / REACTION_CAP;
    const surpriseScore = surprisePctAbs == null
      ? 0
      : Math.min(surprisePctAbs, SURPRISE_CAP_PCT) / SURPRISE_CAP_PCT;
    const composite = W_REACTION * reactionScore + W_SURPRISE * surpriseScore;

    rows.push({
      ticker: entry.ticker,
      displayName: ent.displayName ?? entry.ticker,
      capTier: ent.capTier ?? "unknown",
      period: entry.lastPeriod ?? null,
      eventDate: entry.lastEventDate,
      composite: Number(composite.toFixed(4)),
      components: {
        reaction: {
          absReturn: reactionAbs,
          excessReturn: d3?.excessReturn ?? null,
          score: Number(reactionScore.toFixed(4)),
        },
        surprise: {
          pct: entry.lastSurprisePct ?? null,
          score: Number(surpriseScore.toFixed(4)),
        },
      },
    });
  }

  rows.sort((a, b) => b.composite - a.composite);
  const top = rows.slice(0, OUTPUT_CAP);

  const payload = {
    schema: "ranking/v1",
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    universeSize: rows.length,
    filteredSplitArtifacts: filteredSplit,
    weights: { reaction: W_REACTION, surprise: W_SURPRISE },
    caps: { reactionAbsReturn: REACTION_CAP, surpriseAbsPct: SURPRISE_CAP_PCT },
    rows: top,
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2));

  console.log(`\n=== done ===`);
  console.log(`  universe considered: ${rows.length}`);
  console.log(`  split-artifacts filtered: ${filteredSplit}`);
  console.log(`  rows written: ${top.length}`);
  console.log(`  output → ${path.relative(ROOT, OUT_PATH)}`);
  if (top.length > 0) {
    console.log(`\n  top 10:`);
    for (const r of top.slice(0, 10)) {
      const rxn = r.components.reaction.absReturn;
      const surp = r.components.surprise.pct;
      console.log(
        `    ${r.ticker.padEnd(10)} · comp=${r.composite.toFixed(3)} · rxn=${
          rxn == null ? "  —" : (rxn * 100).toFixed(1).padStart(5) + "%"
        } · surp=${surp == null ? "   —" : surp.toFixed(1).padStart(6) + "%"} · ${r.period ?? "?"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
