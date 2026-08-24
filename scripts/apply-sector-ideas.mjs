#!/usr/bin/env node
/**
 * Apply a sector-ideas payload to data/sector-ideas.json.
 * Called by .claude/commands/sector-ideas.md as the final
 * persistence step. Sanctioned writer — Claude never writes this
 * file via `node -e`.
 *
 *   node scripts/apply-sector-ideas.mjs <payload.json>
 *
 * Behavior:
 *   - Validates envelope shape.
 *   - Validates every theme (thesis/rationale length, ticker format,
 *     3-6 supporting tickers, 3-5 headlines).
 *   - Cross-checks every theme against data/sector-signals.json:
 *       · theme.sector must exist as a sector key
 *       · every supportingTickers[i] must be in that sector's tickers[]
 *       · every keyHeadlines[i] must exist verbatim in that sector's
 *         recentHeadlines[] (ticker + headline match)
 *   - Rejects if the sector-signals snapshot is missing.
 *   - Overwrites data/sector-ideas.json on success.
 *   - Exits 0 on success, 1 on validation failure.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "data", "sector-ideas.json");
const SIGNALS_PATH = path.join(ROOT, "data", "sector-signals.json");

const DISCLAIMER =
  "AI-drafted sector themes — not advice, not a recommendation. Every claim is grounded in on-disk sector-signals; cross-check before acting.";

const [, , PAYLOAD_PATH] = process.argv;
if (!PAYLOAD_PATH) {
  console.error("Usage: node scripts/apply-sector-ideas.mjs <payload.json>");
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

  let signals;
  try {
    signals = JSON.parse(await fs.readFile(SIGNALS_PATH, "utf-8"));
  } catch (e) {
    console.error(
      `::error::cannot read data/sector-signals.json — run aggregate-by-sector.mjs first (${e.message})`,
    );
    process.exit(1);
  }
  const sectorMap = new Map(
    (signals.sectors ?? []).map((s) => [s.sector, s]),
  );

  if (!payload || typeof payload !== "object") {
    console.error("::error::payload must be a JSON object");
    process.exit(1);
  }
  if (payload.schema !== "sector-ideas/v1") {
    console.error(
      `::error::schema must be "sector-ideas/v1" (got ${JSON.stringify(payload.schema)})`,
    );
    process.exit(1);
  }
  if (
    typeof payload.generatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(payload.generatedAt)
  ) {
    console.error("::error::generatedAt must be an ISO datetime string");
    process.exit(1);
  }
  if (
    !Array.isArray(payload.themes) ||
    payload.themes.length < 5 ||
    payload.themes.length > 8
  ) {
    console.error(
      `::error::themes must be an array of 5-8 items (got ${payload.themes?.length ?? 0})`,
    );
    process.exit(1);
  }
  if (
    typeof payload.disclaimer !== "string" ||
    payload.disclaimer.trim() !== DISCLAIMER
  ) {
    console.error(
      `::error::disclaimer must be verbatim: ${JSON.stringify(DISCLAIMER)}`,
    );
    process.exit(1);
  }

  const errors = [];
  const clean = [];
  const seenSectors = new Set();

  for (let i = 0; i < payload.themes.length; i++) {
    const t = payload.themes[i];
    const tag = `themes[${i}]`;

    // Sector must exist in the current snapshot
    if (typeof t.sector !== "string" || !sectorMap.has(t.sector)) {
      errors.push(`${tag}: sector "${t.sector}" not present in sector-signals.json`);
      continue;
    }
    if (seenSectors.has(t.sector)) {
      errors.push(`${tag}: duplicate sector "${t.sector}" — one theme per sector`);
      continue;
    }
    seenSectors.add(t.sector);
    const sec = sectorMap.get(t.sector);

    // Thesis + rationale length
    if (typeof t.thesis !== "string" || t.thesis.length < 60 || t.thesis.length > 200) {
      errors.push(`${tag}: thesis 60-200 chars required (got ${t.thesis?.length ?? 0})`);
      continue;
    }
    if (typeof t.rationale !== "string" || t.rationale.length < 200 || t.rationale.length > 600) {
      errors.push(`${tag}: rationale 200-600 chars required (got ${t.rationale?.length ?? 0})`);
      continue;
    }

    // Supporting tickers: 3-6, all in the sector
    if (!Array.isArray(t.supportingTickers) || t.supportingTickers.length < 3 || t.supportingTickers.length > 6) {
      errors.push(`${tag}: supportingTickers must have 3-6 items`);
      continue;
    }
    const sectorTickers = new Set(sec.tickers ?? []);
    let stOk = true;
    for (const st of t.supportingTickers) {
      if (typeof st !== "string" || !/^[A-Z0-9./-]+ [A-Z]{2}$/.test(st)) {
        errors.push(`${tag}: supportingTicker "${st}" — bad Bloomberg format`);
        stOk = false;
        break;
      }
      if (!sectorTickers.has(st)) {
        errors.push(`${tag}: supportingTicker "${st}" not in sector "${t.sector}"`);
        stOk = false;
        break;
      }
    }
    if (!stOk) continue;

    // Headlines: 3-5, each ticker + headline must exist in sector.recentHeadlines
    if (!Array.isArray(t.keyHeadlines) || t.keyHeadlines.length < 3 || t.keyHeadlines.length > 5) {
      errors.push(`${tag}: keyHeadlines must have 3-5 items`);
      continue;
    }
    const headlineIndex = new Map();
    for (const h of sec.recentHeadlines ?? []) {
      const key = h.ticker + "||" + h.headline;
      headlineIndex.set(key, h);
    }
    let hOk = true;
    const cleanHeadlines = [];
    for (let j = 0; j < t.keyHeadlines.length; j++) {
      const kh = t.keyHeadlines[j];
      const tagH = `${tag}.keyHeadlines[${j}]`;
      if (
        !kh ||
        typeof kh.ticker !== "string" ||
        typeof kh.headline !== "string"
      ) {
        errors.push(`${tagH}: ticker + headline required`);
        hOk = false;
        break;
      }
      const key = kh.ticker + "||" + kh.headline;
      if (!headlineIndex.has(key)) {
        errors.push(
          `${tagH}: no matching headline in sector "${t.sector}" recentHeadlines[] for ticker=${kh.ticker}`,
        );
        hOk = false;
        break;
      }
      const original = headlineIndex.get(key);
      cleanHeadlines.push({
        ticker: original.ticker,
        headline: original.headline,
        source: original.source ?? "",
      });
    }
    if (!hOk) continue;

    // Data-points echo — must match the sector's actual computed values.
    // We ignore whatever Claude wrote and stamp the real values back in,
    // so the UI can't drift from the source of truth.
    clean.push({
      sector: t.sector,
      thesis: t.thesis.trim(),
      rationale: t.rationale.trim(),
      supportingTickers: t.supportingTickers,
      keyHeadlines: cleanHeadlines,
      dataPoints: {
        medianReaction3d: sec.medianReaction3d ?? null,
        newsCountAll: sec.newsCountAll ?? 0,
        tickerCount: sec.tickerCount ?? 0,
      },
    });
  }

  if (errors.length > 0) {
    console.error(`::error::${errors.length} validation errors:`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }

  // Sort themes by |medianReaction3d| desc so the strongest lands first.
  clean.sort((a, b) => {
    const av = a.dataPoints.medianReaction3d ?? 0;
    const bv = b.dataPoints.medianReaction3d ?? 0;
    return Math.abs(bv) - Math.abs(av);
  });

  const out = {
    schema: "sector-ideas/v1",
    generatedAt: payload.generatedAt,
    themes: clean,
    disclaimer: DISCLAIMER,
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`✓ wrote data/sector-ideas.json · ${clean.length} themes`);
  for (const t of clean) {
    console.log(
      `  · ${t.sector.padEnd(24)} · reaction ${(t.dataPoints.medianReaction3d ?? 0).toFixed(2)}% · ${t.supportingTickers.length} tickers · ${t.keyHeadlines.length} headlines`,
    );
  }
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
