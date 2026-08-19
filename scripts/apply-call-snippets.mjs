#!/usr/bin/env node
/**
 * Apply a call-snippets payload to a ticker+period's summary file.
 * Called by /earnings step 3c to persist Claude's extraction. Kept
 * as a script (per the sanctioned-tools rule in
 * .claude/commands/earnings.md) so /earnings never writes summary
 * files via `node -e`.
 *
 *   node scripts/apply-call-snippets.mjs <TICKER> <PERIOD> <payload.json>
 *
 * <payload.json> must be a JSON array of SummaryCallSnippet objects:
 *   [
 *     {
 *       quote: string,            // verbatim, ≤ 45 words, no ellipsis cuts
 *       speaker: string,          // "" allowed when source is a release
 *       role?: "prepared" | "qa",
 *       topic: string,            // ≤ 24 chars, e.g. "margins"
 *       source: { url: string, locator?: string }
 *     }, ...
 *   ]
 *
 * Behavior:
 *   - Locates the summary file at data/summaries/<TICKER_slug>_<PERIOD_slug>.json.
 *   - Replaces summary.callSnippets with the payload.
 *   - Validates every entry (quote/topic non-empty, source.url present,
 *     no quote longer than ~45 words / 400 chars).
 *   - Preserves all other summary fields.
 *   - Exits 0 on success, 1 on failure with descriptive messages.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SUMMARIES_DIR = path.join(ROOT, "data", "summaries");

const [, , TICKER, PERIOD, PAYLOAD_PATH] = process.argv;
if (!TICKER || !PERIOD || !PAYLOAD_PATH) {
  console.error(
    "Usage: node scripts/apply-call-snippets.mjs <TICKER> <PERIOD> <payload.json>",
  );
  process.exit(1);
}

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_./-]/gi, "_");
}
function periodSlug(p) {
  return p.replace(/\s+/g, "_");
}

async function main() {
  const summaryPath = path.join(
    SUMMARIES_DIR,
    `${tickerSlug(TICKER)}_${periodSlug(PERIOD)}.json`,
  );
  let summary;
  try {
    summary = JSON.parse(await fs.readFile(summaryPath, "utf-8"));
  } catch {
    console.error(`::error::summary not found: ${summaryPath}`);
    console.error(
      "  Snippets can only be applied to summaries that already exist.",
    );
    console.error(
      "  Run the KPI-composition step first, then /apply-call-snippets.",
    );
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(await fs.readFile(PAYLOAD_PATH, "utf-8"));
  } catch (e) {
    console.error(`::error::cannot read payload ${PAYLOAD_PATH}: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(payload)) {
    console.error(`::error::payload must be a JSON array of SummaryCallSnippet`);
    process.exit(1);
  }

  const cleaned = [];
  const errors = [];
  for (let i = 0; i < payload.length; i++) {
    const s = payload[i];
    const tag = `snippet[${i}]`;
    if (typeof s.quote !== "string" || s.quote.trim().length < 8) {
      errors.push(`${tag}: quote missing or too short`);
      continue;
    }
    if (s.quote.length > 400) {
      errors.push(`${tag}: quote > 400 chars (target ≤ 45 words)`);
      continue;
    }
    const words = s.quote.trim().split(/\s+/).length;
    if (words > 45) {
      errors.push(`${tag}: quote ${words} words > 45 word limit`);
      continue;
    }
    // Verbatim discipline: reject ellipsis-hiding cuts. Real speech
    // pauses in "…" are allowed only when the transcript itself
    // renders them — but we can't easily tell, so warn instead of
    // rejecting outright when ellipses appear at word boundaries
    // (mid-sentence trims are the common abuse).
    if (/\.\.\./.test(s.quote) || /…/.test(s.quote)) {
      errors.push(`${tag}: quote contains ellipsis — verbatim only, no cuts`);
      continue;
    }
    if (typeof s.speaker !== "string") {
      errors.push(`${tag}: speaker must be a string (use "" for releases)`);
      continue;
    }
    if (s.role !== undefined && s.role !== "prepared" && s.role !== "qa") {
      errors.push(`${tag}: role must be "prepared" | "qa" | omitted`);
      continue;
    }
    if (typeof s.topic !== "string" || s.topic.trim().length < 2) {
      errors.push(`${tag}: topic required (short theme label)`);
      continue;
    }
    if (s.topic.length > 24) {
      errors.push(`${tag}: topic > 24 chars`);
      continue;
    }
    if (!s.source || typeof s.source.url !== "string" || !s.source.url) {
      errors.push(`${tag}: source.url required`);
      continue;
    }
    const entry = {
      quote: s.quote.trim(),
      speaker: s.speaker.trim(),
      topic: s.topic.trim(),
      source: { url: s.source.url },
    };
    if (s.role) entry.role = s.role;
    if (s.source.locator) entry.source.locator = s.source.locator;
    cleaned.push(entry);
  }

  if (errors.length > 0) {
    console.error(`::error::${errors.length} snippet entries rejected:`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }

  summary.callSnippets = cleaned;
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(
    `✓ wrote ${cleaned.length} call snippets to ${TICKER} · ${PERIOD}`,
  );
  const topics = [...new Set(cleaned.map((s) => s.topic))];
  console.log(`  topics: ${topics.slice(0, 8).join(", ")}${topics.length > 8 ? ", …" : ""}`);
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
