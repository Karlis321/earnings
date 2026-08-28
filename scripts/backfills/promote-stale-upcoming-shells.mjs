#!/usr/bin/env node
/**
 * Consume scripts/audits/stale-upcoming-shells.json (produced by
 * audit-stale-upcoming-shells.mjs) and promote each flagged shell
 * to a date-only past event.
 *
 * For each stale entry:
 *   - Find the estimator-projected upcoming shell on the shard
 *     matching the ticker's `nextPeriod`.
 *   - Set eventDate = the SEC 10-Q/10-K reportDate.
 *   - Set scheduledDate = eventDate (matches reality).
 *   - Set sourceLink = { kind:"filing", url: <edgar archive path> }.
 *   - Set provenance = "sec-submissions".
 *   - Leave metrics empty — the next `sec-verbatim` pass (whichever
 *     runs first: refresh-universe or an ad-hoc run of
 *     scripts/backfills/rederive-sec-xbrl.mjs) will populate them
 *     with per-CIK XBRL values.
 *
 * Idempotent: skips events that already carry a filing sourceLink or
 * a non-null eventDate.
 *
 *   node scripts/backfills/promote-stale-upcoming-shells.mjs --dry
 *   node scripts/backfills/promote-stale-upcoming-shells.mjs
 *
 * Writes audit to scripts/audits/promote-stale-upcoming-shells.json.
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const AUDIT_IN = path.join(ROOT, "scripts", "audits", "stale-upcoming-shells.json");
const AUDIT_OUT = path.join(ROOT, "scripts", "audits", "promote-stale-upcoming-shells.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const DRY = process.argv.includes("--dry");

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function main() {
  const input = JSON.parse(await fs.readFile(AUDIT_IN, "utf-8"));
  const stale = input.stale ?? [];
  console.log(`promote-stale-upcoming-shells · dry=${DRY} · targets=${stale.length}`);

  const audit = {
    schema: "promote-stale-upcoming-shells/v1",
    generatedAt: new Date().toISOString(),
    dry: DRY,
    totals: {
      targeted: stale.length,
      promoted: 0,
      skipped_no_shell: 0,
      skipped_already_populated: 0,
      shards_written: 0,
    },
    promoted: [],
    skipped: [],
  };

  const shardCache = new Map();
  for (const s of stale) {
    const slug = tickerSlug(s.ticker);
    const p = path.join(EVENTS_DIR, slug + ".json");
    let shard;
    try {
      shard = JSON.parse(await fs.readFile(p, "utf-8"));
    } catch {
      audit.skipped.push({ ticker: s.ticker, reason: "shard not readable" });
      audit.totals.skipped_no_shell++;
      continue;
    }
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;

    // Find the estimator-projected shell for nextPeriod.
    const shell = events.find(
      (ev) =>
        ev.period === s.nextPeriod &&
        (ev.eventDate == null || ev.eventDate === "") &&
        (ev.scheduledDate === s.nextScheduled ||
          ev.provenance === "estimator-median-gap"),
    );
    if (!shell) {
      audit.skipped.push({
        ticker: s.ticker,
        reason: "no matching estimator shell",
        nextPeriod: s.nextPeriod,
        nextScheduled: s.nextScheduled,
      });
      audit.totals.skipped_no_shell++;
      continue;
    }
    if (shell.eventDate) {
      audit.skipped.push({
        ticker: s.ticker,
        reason: "shell already has eventDate",
        currentEventDate: shell.eventDate,
      });
      audit.totals.skipped_already_populated++;
      continue;
    }

    shell.eventDate = s.latestFiling.report;
    shell.scheduledDate = s.latestFiling.report;
    shell.sourceLink = { kind: "filing", url: s.latestFiling.url };
    shell.provenance = "sec-submissions";
    shell.provenanceAsOf = new Date().toISOString();

    if (!shardCache.has(s.ticker)) {
      shardCache.set(s.ticker, { shardPath: p, shardBody: shard, wrapped, events });
    }
    audit.totals.promoted++;
    audit.promoted.push({
      ticker: s.ticker,
      period: s.nextPeriod,
      priorScheduled: s.nextScheduled,
      newEventDate: s.latestFiling.report,
      form: s.latestFiling.form,
      url: s.latestFiling.url,
    });
  }

  if (!DRY) {
    for (const [ticker, meta] of shardCache) {
      const body = meta.wrapped ? { ...meta.shardBody, events: meta.events } : meta.events;
      fssync.writeFileSync(meta.shardPath, JSON.stringify(body, null, 2));
      audit.totals.shards_written++;
    }
  }

  await fs.writeFile(AUDIT_OUT, JSON.stringify(audit, null, 2));

  console.log(`\n=== done ===`);
  console.log(`  targeted:                 ${audit.totals.targeted}`);
  console.log(`  promoted:                 ${audit.totals.promoted}`);
  console.log(`  skipped (no shell):       ${audit.totals.skipped_no_shell}`);
  console.log(`  skipped (already popd):   ${audit.totals.skipped_already_populated}`);
  console.log(`  shards written:           ${audit.totals.shards_written}`);
  console.log(`  audit → ${path.relative(ROOT, AUDIT_OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
