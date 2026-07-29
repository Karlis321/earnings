#!/usr/bin/env node
/**
 * Revert the 10 mis-mapped SEC-derived eventDates surfaced by
 * `duplicates_detected=10` after the repair-shell-eventdates run.
 *
 * Cause: `repair-shell-eventdates.mjs`'s `periodFromEnd(reportDate)`
 * mapped SEC 6-K filings to calendar-quarter period labels. Fiscal-
 * calendar-offset foreign private issuers (Japanese banks, ABI SA,
 * a handful of US names with non-March-31 year-ends) publish reports
 * whose period label uses their FISCAL quarter — so the mapping put
 * two different fiscal-Q filings into the same/adjacent calendar
 * slot, and countDuplicates' CLOSE_DAYS-in-same-year rule flags the
 * pair.
 *
 * Fix: for events where our SEC-derived eventDate now overlaps a
 * sibling event (within CLOSE_DAYS + same FY label) AND both are
 * `sec-submissions-filingDate` sourced, revert to the period-derived
 * canonical shell date (mid-month 15th of the calendar quarter that
 * fiscal-quarter maps to) and stamp `eventDateEstimated: true`.
 * Yahoo-timeseries corrections are trustworthy (they use the actual
 * quarter-end from Yahoo's asOfDate), so they stay.
 *
 *   node scripts/revert-bad-shell-dates.mjs [--dry]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");
const CLOSE_DAYS = 45;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}
function shellFromPeriod(period) {
  const m = /^FY(\d{4})\s+Q([1-4])$/.exec(period ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const quarter = Number(m[2]);
  // Same calendar-quarter shell the estimator originally used.
  const month = { 1: "04", 2: "07", 3: "10", 4: "01" }[quarter];
  const shellYear = quarter === 4 ? year + 1 : year;
  return `${shellYear}-${month}-15`;
}

async function main() {
  console.log(`revert-bad-shell-dates · dry=${DRY}`);
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));

  const toRevert = []; // {ticker, eventId, oldDate, newDate}
  const shardsToWrite = new Map();

  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const raw = JSON.parse(await fs.readFile(p, "utf-8"));
    const evs = Array.isArray(raw) ? raw : (raw.events ?? []);
    const past = evs.filter((e) => e.eventDate).slice().sort((a, b) =>
      (a.eventDate ?? "").localeCompare(b.eventDate ?? ""),
    );
    // Find close-date pairs where BOTH are sec-submissions-filingDate.
    for (let i = 1; i < past.length; i++) {
      const a = past[i - 1];
      const b = past[i];
      if (a.period === b.period) continue;
      if (daysBetween(a.eventDate, b.eventDate) > CLOSE_DAYS) continue;
      const yA = (a.period ?? "").match(/FY(\d{4})/)?.[1];
      const yB = (b.period ?? "").match(/FY(\d{4})/)?.[1];
      if (yA && yB && yA !== yB) continue;
      // Only touch pairs where OUR repair introduced the collision.
      const aSec = a.eventDateSource === "sec-submissions-filingDate";
      const bSec = b.eventDateSource === "sec-submissions-filingDate";
      if (!aSec && !bSec) continue;
      // Revert both to their period-derived shell + eventDateEstimated
      // so the UI marks (est.) again and countDuplicates stops flagging.
      for (const ev of [a, b]) {
        if (ev.eventDateSource !== "sec-submissions-filingDate") continue;
        const newDate = shellFromPeriod(ev.period);
        if (!newDate) continue;
        toRevert.push({
          ticker: ev.ticker,
          eventId: ev.id,
          period: ev.period,
          oldDate: ev.eventDate,
          newDate,
        });
        ev.eventDate = newDate;
        ev.eventDateEstimated = true;
        delete ev.eventDateSource;
        delete ev.eventDateCorrectedAt;
      }
      shardsToWrite.set(p, { wrapped: !Array.isArray(raw), body: raw, events: evs });
    }
  }

  console.log(`Events to revert: ${toRevert.length}`);
  console.log(`Shards to write:  ${shardsToWrite.size}`);
  for (const r of toRevert) {
    console.log(`  ${r.ticker.padEnd(10)} ${r.period.padEnd(10)} ${r.oldDate} → ${r.newDate}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "revert-bad-shell-dates.json"),
    JSON.stringify({ schema: "revert-bad-shell-dates/v1", generatedAt: new Date().toISOString(), reverted: toRevert }, null, 2),
  );
  console.log(`✓ audit → scripts/audits/revert-bad-shell-dates.json`);

  if (DRY) { console.log("[dry-run] shards NOT written"); return; }
  for (const [p, ctx] of shardsToWrite) {
    const body = ctx.wrapped ? { ...ctx.body, events: ctx.events } : ctx.events;
    await fs.writeFile(p, JSON.stringify(body, null, 2));
  }
  console.log(`✓ updated ${shardsToWrite.size} shards`);
}

main().catch((e) => { console.error(e); process.exit(1); });
