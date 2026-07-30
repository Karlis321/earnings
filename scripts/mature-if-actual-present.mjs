#!/usr/bin/env node
/**
 * Second-pass maturation: promote any event that has metrics.actual
 * populated AND scheduledDate <= today, but eventDate is still null.
 * This handles the case where a prior Yahoo pass wrote actuals to an
 * upcoming shell without flipping eventDate — a legacy shape from the
 * refresh-yahoo-shards run that used period-label matching but didn't
 * promote null eventDate on match.
 *
 *   node scripts/mature-if-actual-present.mjs [--dry]
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");
const TODAY = new Date();
const nowIso = new Date().toISOString();

async function main() {
  console.log(`mature-if-actual-present · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);

  const rollup = {
    schema: "mature-if-actual-present/v1",
    generatedAt: nowIso,
    totals: { shardsRead: 0, shardsWritten: 0, matured: 0 },
    matured: [],
  };

  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const shardPath = path.join(EVENTS_DIR, f);
    let shard;
    try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); } catch { continue; }
    rollup.totals.shardsRead++;
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    const originalJson = JSON.stringify(events);

    for (const e of events) {
      if (e.eventDate) continue;
      if (!e.scheduledDate) continue;
      if (new Date(e.scheduledDate) > TODAY) continue;
      // Must have at least one metric with a real actual value.
      const hasActual = (e.metrics ?? []).some(
        (m) => m.actual?.value != null,
      );
      if (!hasActual) continue;

      // Pick eventDate from actual.asOf if it's a real report date;
      // otherwise fall back to scheduledDate.
      const anyAsOf = (e.metrics ?? [])
        .map((m) => m.actual?.asOf)
        .filter(Boolean)
        .sort()
        .pop();
      e.eventDate = anyAsOf ?? e.scheduledDate;
      e.eventDateSource = "mature-if-actual-present";
      e.freshness = "fresh";
      if (!Array.isArray(e.reaction?.points) || e.reaction.points.length === 0) {
        const entity = byTicker.get(e.ticker);
        e.reaction = {
          benchmark: entity?.benchmark ?? "",
          baselineDate: null,
          baselineClose: null,
          points: [
            { horizon: "d1", absReturn: null, excessReturn: null, benchmark: entity?.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
            { horizon: "d3", absReturn: null, excessReturn: null, benchmark: entity?.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
            { horizon: "w1", absReturn: null, excessReturn: null, benchmark: entity?.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
            { horizon: "m1", absReturn: null, excessReturn: null, benchmark: entity?.benchmark ?? "", computedAt: null, populatesOn: null, status: "pending" },
          ],
        };
      }
      rollup.totals.matured++;
      rollup.matured.push({ ticker: e.ticker, period: e.period, eventDate: e.eventDate });
    }

    const nextJson = JSON.stringify(events);
    if (nextJson !== originalJson && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`\n=== mature-if-actual-present ===`);
  console.log(`Shards read:    ${rollup.totals.shardsRead}`);
  console.log(`Shards written: ${rollup.totals.shardsWritten}`);
  console.log(`Events matured: ${rollup.totals.matured}`);
  for (const m of rollup.matured.slice(0, 30)) {
    console.log(`  ${m.ticker.padEnd(14)} ${m.period.padEnd(12)} eventDate=${m.eventDate}`);
  }
  if (rollup.matured.length > 30) console.log(`  … +${rollup.matured.length - 30} more`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "mature-if-actual-present.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/mature-if-actual-present.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
