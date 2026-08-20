#!/usr/bin/env node
/**
 * Apply a framework-screen payload to data/screens/<framework>.json.
 * Called by .claude/commands/blue-ocean.md + rule-breaker.md as the
 * final persistence step. Sanctioned writer — Claude never writes
 * screens JSON via `node -e`.
 *
 *   node scripts/apply-screen.mjs <framework> <payload.json>
 *
 * <framework> is either "blue-ocean" or "rule-breaker" and
 * determines the output filename + the dimension-key allowlist.
 *
 * <payload.json> is a partial Screen envelope carrying:
 *   - optional `dimensions[]` (only respected on first-run when the
 *     file doesn't yet exist; ignored thereafter — frameworks are
 *     schema-frozen once shipped)
 *   - required `screens[]` — one or more ScreenCards to merge
 *
 * Merge behavior:
 *   - If data/screens/<framework>.json exists, load it, keep any
 *     existing screens whose ticker isn't in the incoming payload,
 *     add/replace tickers that ARE in the payload. Never delete.
 *   - Bump `generatedAt` to now.
 *
 * Validation (strict):
 *   - Composite score must equal mean(dimension scores) within 0.5.
 *   - Every dimension key in the payload must exist in the file's
 *     dimensions[] list.
 *   - Verdict + rationale length constraints per schema.
 *   - Ticker format matches other apply scripts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SCREENS_DIR = path.join(ROOT, "data", "screens");

const FRAMEWORKS = new Set(["blue-ocean", "rule-breaker"]);

// Frozen dimension lists — first run of each framework writes these
// into the output file; subsequent runs must match keys exactly.
const DIMENSION_DEFS = {
  "blue-ocean": [
    {
      key: "value-innovation",
      label: "Value innovation",
      description:
        "Does the company simultaneously drive down costs AND lift buyer value? Core Blue Ocean move — pursuing both usually creates uncontested space.",
    },
    {
      key: "uncontested-space",
      label: "Uncontested market space",
      description:
        "Is the company competing in a red ocean (crowded, price-driven) or a genuinely new/uncontested space where the rules aren't set yet?",
    },
    {
      key: "demand-creation",
      label: "New demand creation",
      description:
        "Does the company convert non-customers into customers, or is it fighting for share within an existing pie?",
    },
    {
      key: "strategic-move",
      label: "Distinctive strategic move",
      description:
        "Is there one identifiable big strategic move (product, model, geography) that defines the moat, or is the story incremental?",
    },
    {
      key: "cost-leadership",
      label: "Cost + value alignment",
      description:
        "Have they broken the value-cost trade-off through elimination / reduction / raising / creation of value elements?",
    },
  ],
  "rule-breaker": [
    {
      key: "top-dog-first-mover",
      label: "Top dog + first mover",
      description:
        "Is the company the leader in an important, emerging industry — the visibly dominant name, not a fast follower?",
    },
    {
      key: "sustainable-advantage",
      label: "Sustainable advantage",
      description:
        "Real barriers to entry — network effects, IP, cost curves, brand — sufficient to defend growth over 5+ years?",
    },
    {
      key: "management-backing",
      label: "Strong management + backing",
      description:
        "Founder-led or otherwise mission-aligned leadership; institutional or founder ownership above average for the sector.",
    },
    {
      key: "consumer-appeal",
      label: "Strong consumer appeal",
      description:
        "Enthusiastic user base — high NPS, viral distribution, or a category-defining brand people voluntarily pay a premium for.",
    },
    {
      key: "overvalued-conventional",
      label: "Overvalued (conventional wisdom)",
      description:
        "Does conventional finance rate the stock 'expensive' on standard multiples? Rule Breakers PAYS UP for growth others discount.",
    },
  ],
};

const [, , FRAMEWORK, PAYLOAD_PATH] = process.argv;
if (!FRAMEWORK || !PAYLOAD_PATH) {
  console.error("Usage: node scripts/apply-screen.mjs <framework> <payload.json>");
  process.exit(1);
}
if (!FRAMEWORKS.has(FRAMEWORK)) {
  console.error(`::error::unknown framework "${FRAMEWORK}" (allowed: ${[...FRAMEWORKS].join(", ")})`);
  process.exit(1);
}

async function main() {
  const outPath = path.join(SCREENS_DIR, `${FRAMEWORK}.json`);
  await fs.mkdir(SCREENS_DIR, { recursive: true });

  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(outPath, "utf-8"));
  } catch {
    // First-run — will be created below.
  }

  const dimensions = DIMENSION_DEFS[FRAMEWORK];
  const dimKeys = new Set(dimensions.map((d) => d.key));

  let payload;
  try {
    payload = JSON.parse(await fs.readFile(PAYLOAD_PATH, "utf-8"));
  } catch (e) {
    console.error(`::error::cannot read payload ${PAYLOAD_PATH}: ${e.message}`);
    process.exit(1);
  }

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.screens)) {
    console.error("::error::payload must be an object with a screens[] array");
    process.exit(1);
  }
  if (payload.screens.length === 0) {
    console.error("::error::screens[] cannot be empty");
    process.exit(1);
  }
  if (payload.screens.length > 20) {
    console.error("::error::batch capped at 20 screens per apply call");
    process.exit(1);
  }

  const errors = [];
  const clean = [];
  for (let i = 0; i < payload.screens.length; i++) {
    const s = payload.screens[i];
    const tag = `screens[${i}]`;
    if (!s.ticker || !/^[A-Z0-9./-]+ [A-Z]{2}$/.test(s.ticker)) {
      errors.push(`${tag}: ticker must be Bloomberg-style`);
      continue;
    }
    if (typeof s.displayName !== "string" || s.displayName.length < 2) {
      errors.push(`${tag}: displayName required`);
      continue;
    }
    if (!Array.isArray(s.dimensions) || s.dimensions.length !== dimensions.length) {
      errors.push(
        `${tag}: dimensions[] must have exactly ${dimensions.length} entries for ${FRAMEWORK}`,
      );
      continue;
    }
    let dimSum = 0;
    let dimOk = true;
    const cleanDims = [];
    for (let j = 0; j < s.dimensions.length; j++) {
      const d = s.dimensions[j];
      const dtag = `${tag}.dimensions[${j}]`;
      if (!d.key || !dimKeys.has(d.key)) {
        errors.push(`${dtag}: unknown key "${d.key}" (allowed: ${[...dimKeys].join(", ")})`);
        dimOk = false;
        break;
      }
      if (typeof d.score !== "number" || d.score < 0 || d.score > 100) {
        errors.push(`${dtag}: score must be 0-100`);
        dimOk = false;
        break;
      }
      if (typeof d.rationale !== "string" || d.rationale.length < 20 || d.rationale.length > 280) {
        errors.push(`${dtag}: rationale 20-280 chars required`);
        dimOk = false;
        break;
      }
      dimSum += d.score;
      cleanDims.push({
        key: d.key,
        score: Number(d.score.toFixed(1)),
        rationale: d.rationale.trim(),
      });
    }
    if (!dimOk) continue;
    const composite = dimSum / cleanDims.length;
    if (typeof s.compositeScore !== "number" || Math.abs(composite - s.compositeScore) > 0.5) {
      errors.push(
        `${tag}: compositeScore ${s.compositeScore} disagrees with mean of dimensions (${composite.toFixed(2)})`,
      );
      continue;
    }
    if (typeof s.verdict !== "string" || s.verdict.length < 20 || s.verdict.length > 320) {
      errors.push(`${tag}: verdict 20-320 chars required`);
      continue;
    }
    if (!Array.isArray(s.sources) || s.sources.length < 1) {
      errors.push(`${tag}: at least one source required`);
      continue;
    }
    if (
      s.sources.some(
        (src) =>
          !src ||
          !["summary", "shard", "filing", "release", "web"].includes(src.kind) ||
          typeof src.ref !== "string" ||
          src.ref.length < 3,
      )
    ) {
      errors.push(`${tag}: source entries need {kind, ref} with valid kind`);
      continue;
    }
    clean.push({
      ticker: s.ticker,
      companyId: s.companyId ?? null,
      displayName: s.displayName.trim(),
      compositeScore: Number(composite.toFixed(1)),
      dimensions: cleanDims,
      verdict: s.verdict.trim(),
      sources: s.sources.map((src) => ({ kind: src.kind, ref: src.ref })),
      screenedAt: s.screenedAt ?? new Date().toISOString(),
    });
  }

  if (errors.length > 0) {
    console.error(`::error::${errors.length} screen entries rejected:`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }

  // Merge with existing (keep unmentioned tickers, overwrite matched ones).
  // Also stamp previous compositeScore + screenedAt on each incoming row
  // so the UI can render a delta chip without reading the change log.
  const byTicker = new Map();
  if (existing?.screens) {
    for (const row of existing.screens) byTicker.set(row.ticker, row);
  }

  const changeLogRows = [];
  for (const row of clean) {
    const prior = byTicker.get(row.ticker);
    const beforeScore =
      prior && typeof prior.compositeScore === "number"
        ? prior.compositeScore
        : null;
    row.previousCompositeScore = beforeScore;
    row.previousScreenedAt = prior?.screenedAt ?? null;

    // Only log a change row when there IS a delta (skip first-run
    // ingests to avoid flooding the log with initial coverage).
    if (beforeScore !== null && Math.abs(beforeScore - row.compositeScore) >= 0.5) {
      changeLogRows.push({
        screenedAt: row.screenedAt,
        framework: FRAMEWORK,
        ticker: row.ticker,
        compositeBefore: beforeScore,
        compositeAfter: row.compositeScore,
        compositeDelta: Number((row.compositeScore - beforeScore).toFixed(1)),
      });
    }

    byTicker.set(row.ticker, row);
  }

  const out = {
    schema: "screen/v1",
    framework: FRAMEWORK,
    generatedAt: new Date().toISOString(),
    dimensions,
    screens: [...byTicker.values()].sort(
      (a, b) => b.compositeScore - a.compositeScore,
    ),
  };

  await fs.writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(
    `✓ wrote ${clean.length} new/updated screens to ${outPath} (total in file: ${out.screens.length})`,
  );
  console.log(`  tickers this run: ${clean.map((c) => c.ticker).join(", ")}`);

  if (changeLogRows.length > 0) {
    const logPath = path.join(SCREENS_DIR, `${FRAMEWORK}-change-log.jsonl`);
    const lines = changeLogRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await fs.appendFile(logPath, lines);
    console.log(
      `✓ appended ${changeLogRows.length} rows to ${FRAMEWORK}-change-log.jsonl`,
    );
    for (const r of changeLogRows) {
      const sign = r.compositeDelta >= 0 ? "+" : "";
      console.log(
        `  · ${r.ticker}: ${r.compositeBefore} → ${r.compositeAfter} (${sign}${r.compositeDelta})`,
      );
    }
  }
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
