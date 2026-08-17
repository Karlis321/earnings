#!/usr/bin/env node
/**
 * Fix events labeled with a period that a sibling (reported past
 * event) already occupies on the same shard. Symptom: pipeline
 * report's `estimator_label_conflicts` counter fires, and the UI's
 * `find(e => e.period === "FY2026 Q1")` grabs whichever event
 * indexes first — for PSNY_US that was a September upcoming shell
 * masquerading as the reported March quarter.
 *
 * Root cause: `periodFromDate(iso)` in the estimator uses calendar
 * quarter arithmetic on the scheduledDate, but fiscal-offset issuers
 * (Japanese banks, PSNY/PSN Polestar, Chinese semi-annual filers,
 * some Indonesian names) don't align their fiscal quarter with the
 * calendar quarter of the report date. CLAUDE.md load-bearing rule:
 *   "ANY logic mapping dates↔periods must resolve through the
 *    entity's fiscal calendar, never calendar-quarter arithmetic
 *    on a report-end date."
 *
 * The daily cron's incrementPeriod fix (Sweep 1) already stopped
 * NEW conflicts from being seeded. This script cleans the residuals:
 * for each shard, if two events share `period` and one has a real
 * `eventDate` while the other is a future shell (`eventDate:null`,
 * `scheduledDate > today`), the shell is bumped to the next period.
 *
 * Bump rule: Q1→Q2, Q2→Q3, Q3→Q4, Q4→next FY Q1. Simple linear
 * increment. Not perfect for semi-annual filers whose true next
 * report is FY+1 Q3 rather than Q2, but the estimator's next
 * cron pass will overwrite the label using cadence data. The point
 * here is to make the shard unambiguous NOW; the estimator does
 * the correct assignment on the next mature-* run.
 *
 *   node scripts/fix-label-conflicts.mjs [--dry]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const DRY = process.argv.includes("--dry");

const PERIOD_RE = /^FY(\d{4}) Q([1-4])$/;
function incrementPeriod(label) {
  const m = label.match(PERIOD_RE);
  if (!m) return null;
  let fy = Number(m[1]);
  let q = Number(m[2]);
  q += 1;
  if (q > 4) { q = 1; fy += 1; }
  return `FY${fy} Q${q}`;
}

async function main() {
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  const today = new Date().toISOString().slice(0, 10);
  let touched = 0;
  let bumped = 0;
  const detail = [];
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const shard = JSON.parse(await fs.readFile(p, "utf-8"));
    const events = Array.isArray(shard) ? shard : (shard.events ?? []);
    // Group by period; find periods where >1 event exists.
    const byPeriod = new Map();
    for (const e of events) {
      if (!e.period) continue;
      const arr = byPeriod.get(e.period) ?? [];
      arr.push(e);
      byPeriod.set(e.period, arr);
    }
    let changed = false;
    for (const [period, arr] of byPeriod) {
      if (arr.length < 2) continue;
      const reported = arr.filter((e) => e.eventDate);
      const shells = arr.filter((e) => !e.eventDate && (e.scheduledDate ?? "") > today);
      if (reported.length === 0 || shells.length === 0) continue;
      // Duplicate found: bump every shell to next period.
      for (const shell of shells) {
        const next = incrementPeriod(shell.period);
        if (!next) continue;
        detail.push(`${f.replace(/\.json$/, "")} · ${shell.period} → ${next} · shell id=${shell.id} sched=${shell.scheduledDate}`);
        shell.period = next;
        shell.periodBumpedFrom = period;
        shell.periodBumpedReason = "label-conflict-with-reported-sibling";
        shell.periodBumpedAt = new Date().toISOString();
        bumped++;
        changed = true;
      }
    }
    if (changed) {
      touched++;
      if (!DRY) {
        await fs.writeFile(p, JSON.stringify(shard, null, 2) + "\n", "utf-8");
      }
    }
  }
  console.log(`\n=== fix-label-conflicts ${DRY ? "(dry-run)" : ""} ===`);
  console.log(`  shards touched:  ${touched}`);
  console.log(`  shells bumped:   ${bumped}`);
  if (detail.length) {
    console.log(`\n  detail:`);
    for (const d of detail) console.log(`    ${d}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
