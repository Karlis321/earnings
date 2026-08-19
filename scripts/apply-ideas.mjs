#!/usr/bin/env node
/**
 * Apply an ideas-pitch payload to data/ideas.json. Called by
 * .claude/commands/ideas.md as the final persistence step. Kept as
 * a script (per the sanctioned-tools rule in earnings.md/ideas.md)
 * so Claude never writes ideas.json via `node -e`.
 *
 *   node scripts/apply-ideas.mjs <payload.json>
 *
 * <payload.json> must be a full Ideas envelope:
 *   {
 *     "schema": "ideas/v1",
 *     "generatedAt": "2026-08-19T...",
 *     "universe": "sp500∪r1000∪isCore-operating",
 *     "disclaimer": "AI research over the covered universe — not advice.",
 *     "pitches": [ IdeaPitch, ... ]
 *   }
 *
 * Behavior:
 *   - Validates schema field + envelope shape.
 *   - Validates every pitch entry (thesis ≤ 20 words, rationale
 *     60-800 chars, at least 1 risk, at least 1 source).
 *   - Cross-checks that ticker + rank + compositeScore match a row
 *     in the current data/ranking.json (rejects if the pitch drifted
 *     from the ranking it claims to summarize).
 *   - Overwrites data/ideas.json on success.
 *   - Exits 0 on success, 1 on any validation failure.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const IDEAS_PATH = path.join(ROOT, "data", "ideas.json");
const RANKING_PATH = path.join(ROOT, "data", "ranking.json");

const [, , PAYLOAD_PATH] = process.argv;
if (!PAYLOAD_PATH) {
  console.error("Usage: node scripts/apply-ideas.mjs <payload.json>");
  process.exit(1);
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(PAYLOAD_PATH, "utf-8"));
  } catch (e) {
    console.error(`::error::cannot read payload ${PAYLOAD_PATH}: ${e.message}`);
    process.exit(1);
  }

  if (!payload || typeof payload !== "object") {
    console.error("::error::payload must be a JSON object");
    process.exit(1);
  }
  if (payload.schema !== "ideas/v1") {
    console.error(`::error::schema must be "ideas/v1" (got ${JSON.stringify(payload.schema)})`);
    process.exit(1);
  }
  if (typeof payload.generatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(payload.generatedAt)) {
    console.error("::error::generatedAt must be an ISO datetime string");
    process.exit(1);
  }
  if (typeof payload.universe !== "string" || !payload.universe) {
    console.error("::error::universe required");
    process.exit(1);
  }
  if (typeof payload.disclaimer !== "string" || payload.disclaimer.length < 20) {
    console.error("::error::disclaimer required (≥ 20 chars)");
    process.exit(1);
  }
  if (!Array.isArray(payload.pitches) || payload.pitches.length === 0) {
    console.error("::error::pitches must be a non-empty array");
    process.exit(1);
  }
  if (payload.pitches.length > 20) {
    console.error("::error::pitches capped at 20");
    process.exit(1);
  }

  // Cross-check pitches against the current ranking. Refuses to
  // persist a stale set (rank drift is common if the ranking gets
  // rerun mid-composition). Missing ranking file → skip the
  // cross-check but warn.
  let rankingByTicker = null;
  try {
    const ranking = JSON.parse(await fs.readFile(RANKING_PATH, "utf-8"));
    rankingByTicker = new Map((ranking.rows ?? []).map((r) => [r.ticker, r]));
  } catch {
    console.warn(
      "::warning::data/ranking.json not present — skipping rank cross-check",
    );
  }

  const errors = [];
  const clean = [];
  for (let i = 0; i < payload.pitches.length; i++) {
    const p = payload.pitches[i];
    const tag = `pitch[${i}]`;
    if (!p.ticker || !/^[A-Z0-9./-]+ [A-Z]{2}$/.test(p.ticker)) {
      errors.push(`${tag}: ticker must be Bloomberg-style (e.g. "AAPL US")`);
      continue;
    }
    if (typeof p.rank !== "number" || p.rank < 1) {
      errors.push(`${tag}: rank must be integer ≥ 1`);
      continue;
    }
    if (typeof p.compositeScore !== "number" || p.compositeScore < -1 || p.compositeScore > 1) {
      errors.push(`${tag}: compositeScore must be in [-1, 1]`);
      continue;
    }
    if (typeof p.thesis !== "string" || p.thesis.length < 8 || p.thesis.length > 160) {
      errors.push(`${tag}: thesis 8-160 chars required`);
      continue;
    }
    const thesisWords = p.thesis.trim().split(/\s+/).length;
    if (thesisWords > 20) {
      errors.push(`${tag}: thesis ${thesisWords} words > 20 word cap`);
      continue;
    }
    if (typeof p.rationale !== "string" || p.rationale.length < 60 || p.rationale.length > 800) {
      errors.push(`${tag}: rationale 60-800 chars required`);
      continue;
    }
    if (!Array.isArray(p.risks) || p.risks.length < 1 || p.risks.length > 4) {
      errors.push(`${tag}: risks 1-4 required`);
      continue;
    }
    if (p.risks.some((r) => typeof r !== "string" || r.length < 8 || r.length > 200)) {
      errors.push(`${tag}: each risk 8-200 chars`);
      continue;
    }
    if (!p.catalyst || typeof p.catalyst.label !== "string" || p.catalyst.label.length < 4) {
      errors.push(`${tag}: catalyst.label required`);
      continue;
    }
    if (!Array.isArray(p.sources) || p.sources.length < 1) {
      errors.push(`${tag}: at least one source ref required`);
      continue;
    }
    if (
      p.sources.some(
        (s) =>
          !s ||
          !s.kind ||
          !["summary", "shard", "ranking", "filing", "release"].includes(s.kind) ||
          typeof s.ref !== "string" ||
          !s.ref,
      )
    ) {
      errors.push(`${tag}: source entries must be {kind, ref} with valid kind`);
      continue;
    }
    // Cross-check with ranking when available.
    if (rankingByTicker) {
      const row = rankingByTicker.get(p.ticker);
      if (!row) {
        errors.push(`${tag}: ticker ${p.ticker} not in current ranking`);
        continue;
      }
      if (row.rank !== p.rank) {
        errors.push(
          `${tag}: rank ${p.rank} disagrees with ranking (has rank ${row.rank})`,
        );
        continue;
      }
      if (Math.abs(row.compositeScore - p.compositeScore) > 0.001) {
        errors.push(
          `${tag}: compositeScore ${p.compositeScore} disagrees with ranking (has ${row.compositeScore})`,
        );
        continue;
      }
    }
    // Normalized entry
    const entry = {
      ticker: p.ticker,
      rank: p.rank,
      compositeScore: p.compositeScore,
      thesis: p.thesis.trim(),
      rationale: p.rationale.trim(),
      risks: p.risks.map((r) => r.trim()),
      catalyst: {
        label: p.catalyst.label.trim(),
        ...(p.catalyst.date ? { date: p.catalyst.date } : {}),
      },
      sources: p.sources.map((s) => ({ kind: s.kind, ref: s.ref })),
    };
    clean.push(entry);
  }

  if (errors.length > 0) {
    console.error(`::error::${errors.length} pitch entries rejected:`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }

  const out = {
    schema: "ideas/v1",
    generatedAt: payload.generatedAt,
    universe: payload.universe,
    disclaimer: payload.disclaimer.trim(),
    pitches: clean,
  };

  await fs.writeFile(IDEAS_PATH, JSON.stringify(out, null, 2));
  console.log(`✓ wrote ${clean.length} pitches to data/ideas.json`);
  console.log(`  tickers: ${clean.slice(0, 8).map((p) => p.ticker).join(", ")}${clean.length > 8 ? ", …" : ""}`);
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
