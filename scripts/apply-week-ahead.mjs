#!/usr/bin/env node
/**
 * Apply a week-ahead narrative payload to data/week-ahead-narrative.json.
 * Called by .claude/commands/week-ahead.md as the final persistence
 * step. Sanctioned writer — Claude never writes this file via
 * `node -e`.
 *
 *   node scripts/apply-week-ahead.mjs <payload.json>
 *
 * <payload.json> must be a full envelope matching the schema in
 * data/week-ahead-schema.json.
 *
 * Behavior:
 *   - Validates envelope shape.
 *   - Validates every section (heading + body length constraints).
 *   - Validates every highlight (ticker format, note length, date).
 *   - Cross-checks every highlight.ticker + eventDate against
 *     data/events-index.json (rejects if a highlight cites a ticker
 *     that isn't reporting this week).
 *   - Overwrites data/week-ahead-narrative.json on success.
 *   - Exits 0 on success, 1 on validation failure.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "data", "week-ahead-narrative.json");
const ARCHIVE_DIR = path.join(ROOT, "data", "week-ahead-archive");
const INDEX_PATH = path.join(ROOT, "data", "events-index.json");

const [, , PAYLOAD_PATH] = process.argv;
if (!PAYLOAD_PATH) {
  console.error("Usage: node scripts/apply-week-ahead.mjs <payload.json>");
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
  if (payload.schema !== "week-ahead-narrative/v1") {
    console.error(
      `::error::schema must be "week-ahead-narrative/v1" (got ${JSON.stringify(payload.schema)})`,
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
    typeof payload.weekOf !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(payload.weekOf)
  ) {
    console.error("::error::weekOf must be YYYY-MM-DD");
    process.exit(1);
  }
  if (typeof payload.eventsCount !== "number" || payload.eventsCount < 0) {
    console.error("::error::eventsCount required (non-negative integer)");
    process.exit(1);
  }

  const errors = [];

  // Sections
  if (!Array.isArray(payload.sections) || payload.sections.length < 2 || payload.sections.length > 5) {
    errors.push("sections must be an array of 2-5 items");
  } else {
    for (let i = 0; i < payload.sections.length; i++) {
      const s = payload.sections[i];
      const tag = `sections[${i}]`;
      if (typeof s.heading !== "string" || s.heading.length < 3 || s.heading.length > 60) {
        errors.push(`${tag}: heading 3-60 chars required`);
      }
      if (typeof s.body !== "string" || s.body.length < 80 || s.body.length > 900) {
        errors.push(`${tag}: body 80-900 chars required (got ${s.body?.length ?? 0})`);
      }
    }
  }

  // Highlights + cross-check against events-index
  let indexByTicker = null;
  try {
    const idx = JSON.parse(await fs.readFile(INDEX_PATH, "utf-8"));
    indexByTicker = new Map((idx.entries ?? []).map((e) => [e.ticker, e]));
  } catch {
    console.warn(
      "::warning::events-index.json not readable — skipping highlight cross-check",
    );
  }

  if (!Array.isArray(payload.highlights) || payload.highlights.length < 3 || payload.highlights.length > 8) {
    errors.push("highlights must be an array of 3-8 items");
  } else {
    for (let i = 0; i < payload.highlights.length; i++) {
      const h = payload.highlights[i];
      const tag = `highlights[${i}]`;
      if (!h.ticker || !/^[A-Z0-9./-]+ [A-Z]{2}$/.test(h.ticker)) {
        errors.push(`${tag}: ticker must be Bloomberg-style`);
        continue;
      }
      if (typeof h.note !== "string" || h.note.length < 20 || h.note.length > 240) {
        errors.push(`${tag}: note 20-240 chars required (got ${h.note?.length ?? 0})`);
        continue;
      }
      if (typeof h.eventDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(h.eventDate)) {
        errors.push(`${tag}: eventDate must be YYYY-MM-DD`);
        continue;
      }
      if (indexByTicker) {
        const row = indexByTicker.get(h.ticker);
        if (!row) {
          errors.push(`${tag}: ticker ${h.ticker} not in events-index`);
          continue;
        }
        if (row.nextScheduled !== h.eventDate) {
          errors.push(
            `${tag}: eventDate ${h.eventDate} disagrees with events-index nextScheduled (${row.nextScheduled ?? "null"}) for ${h.ticker}`,
          );
          continue;
        }
      }
    }
  }

  if (typeof payload.disclaimer !== "string" || payload.disclaimer.length < 20) {
    errors.push("disclaimer required (≥ 20 chars)");
  }

  if (errors.length > 0) {
    console.error(`::error::${errors.length} validation errors:`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }

  // Normalized output
  const out = {
    schema: "week-ahead-narrative/v1",
    generatedAt: payload.generatedAt,
    weekOf: payload.weekOf,
    eventsCount: payload.eventsCount,
    sections: payload.sections.map((s) => ({
      heading: s.heading.trim(),
      body: s.body.trim(),
    })),
    highlights: payload.highlights.map((h) => ({
      ticker: h.ticker,
      note: h.note.trim(),
      eventDate: h.eventDate,
    })),
    disclaimer: payload.disclaimer.trim(),
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`✓ wrote data/week-ahead-narrative.json`);
  console.log(
    `  weekOf: ${out.weekOf} · ${out.sections.length} sections · ${out.highlights.length} highlights`,
  );

  // Phase 3.3 — per-week archive so past narratives are retrievable
  // after the current file is overwritten. Filename is the Monday of
  // the week the narrative covers; safe to overwrite if the same week
  // reruns (idempotent).
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const archivePath = path.join(ARCHIVE_DIR, `${out.weekOf}.json`);
  await fs.writeFile(archivePath, JSON.stringify(out, null, 2));
  console.log(`✓ archived to data/week-ahead-archive/${out.weekOf}.json`);
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
