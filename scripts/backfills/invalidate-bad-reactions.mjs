#!/usr/bin/env node
/**
 * Invalidate reaction points whose baseline was anchored on the wrong
 * (SEC-derived-but-fiscal-offset) eventDate.
 *
 * Context: `repair-shell-eventdates.mjs` set 18 events' eventDates to
 * SEC 6-K filing dates, but the calendar-quarter mapping was wrong for
 * fiscal-offset issuers. `backfill-reactions.mjs` then baselined
 * reactions off those wrong dates. `revert-bad-shell-dates.mjs`
 * reverted the eventDate — but the baselineDate/baselineClose on the
 * event's `reaction` object are stale (still anchored to the wrong
 * SEC-derived date). Wrong-anchor reactions are worse than none.
 *
 * Signal for "baselined off wrong SEC date": for events in
 * `scripts/audits/revert-bad-shell-dates.json`, if
 * `reaction.baselineDate` is NOT on the mid-month 15th shell pattern
 * (i.e., doesn't match the period's shell date), the baseline came
 * from pickBaselineIdx running with anchor = wrong SEC date.
 *
 * Fix: for each such event, mark every reaction point
 * `status: "unavailable"` + `absReturn: null` + `excessReturn: null`,
 * clear `baselineDate` + `baselineClose` so a future mature (with a
 * real report date) reseeds cleanly, and stamp a `reactionInvalidated`
 * marker on the reaction for auditability.
 *
 *   node scripts/invalidate-bad-reactions.mjs [--dry]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const REVERT_AUDIT = path.join(ROOT, "scripts", "audits", "revert-bad-shell-dates.json");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function main() {
  console.log(`invalidate-bad-reactions · dry=${DRY}`);
  const audit = JSON.parse(await fs.readFile(REVERT_AUDIT, "utf-8"));
  const targets = audit.reverted ?? [];
  console.log(`Reverted events to check: ${targets.length}`);

  const nowIso = new Date().toISOString();
  const invalidated = [];
  const skippedShellBaseline = [];
  const shardsToWrite = new Map();

  for (const t of targets) {
    const shardPath = path.join(EVENTS_DIR, tickerSlug(t.ticker) + ".json");
    let raw;
    try { raw = JSON.parse(await fs.readFile(shardPath, "utf-8")); }
    catch { continue; }
    const evs = Array.isArray(raw) ? raw : (raw.events ?? []);
    const ev = evs.find((e) => e.id === t.eventId);
    if (!ev) continue;
    const baselineDate = ev.reaction?.baselineDate;
    // Shell-pattern baseline = ends in "-15". Those were baselined
    // pre-repair and their anchor was the (now-reverted) shell 15th,
    // which matches the current eventDate — no invalidation needed.
    if (typeof baselineDate === "string" && /-15$/.test(baselineDate)) {
      skippedShellBaseline.push({ ticker: t.ticker, period: t.period, baselineDate, reason: "shell-15th baseline — anchor matches current eventDate" });
      continue;
    }
    // Otherwise: baseline came from a non-shell date (either the wrong
    // SEC date directly, or the next-bar after it). Invalidate.
    const pts = ev.reaction?.points ?? [];
    let touched = 0;
    for (const p of pts) {
      if (p.absReturn != null || p.excessReturn != null || (p.status && p.status !== "pending")) {
        touched++;
        p.absReturn = null;
        p.excessReturn = null;
        p.status = "unavailable";
        p.computedAt = nowIso;
        delete p.gapFlagged;
        delete p.clipped;
        delete p.contaminated;
      }
    }
    if (ev.reaction) {
      ev.reaction.baselineDate = null;
      ev.reaction.baselineClose = null;
      ev.reaction.reactionInvalidated = {
        reason: "baselined off fiscal-offset SEC eventDate that was later reverted",
        formerBaselineDate: baselineDate ?? null,
        invalidatedAt: nowIso,
      };
    }
    invalidated.push({ ticker: t.ticker, period: t.period, eventId: t.eventId, formerBaselineDate: baselineDate, pointsInvalidated: touched });
    shardsToWrite.set(shardPath, { wrapped: !Array.isArray(raw), body: raw, events: evs });
  }

  console.log(`Events invalidated:           ${invalidated.length}`);
  console.log(`Events skipped (shell base):  ${skippedShellBaseline.length}`);
  console.log(`Shards to write:              ${shardsToWrite.size}`);
  for (const r of invalidated) {
    console.log(`  ${r.ticker.padEnd(10)} ${r.period.padEnd(10)} baselineDate=${r.formerBaselineDate} · points invalidated=${r.pointsInvalidated}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "invalidate-bad-reactions.json"),
    JSON.stringify(
      { schema: "invalidate-bad-reactions/v1", generatedAt: nowIso, invalidated, skippedShellBaseline },
      null,
      2,
    ),
  );
  console.log(`✓ audit → scripts/audits/invalidate-bad-reactions.json`);

  if (DRY) { console.log("[dry-run] shards NOT written"); return; }
  for (const [p, ctx] of shardsToWrite) {
    const body = ctx.wrapped ? { ...ctx.body, events: ctx.events } : ctx.events;
    await fs.writeFile(p, JSON.stringify(body, null, 2));
  }
  console.log(`✓ updated ${shardsToWrite.size} shards`);
}

main().catch((e) => { console.error(e); process.exit(1); });
