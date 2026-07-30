#!/usr/bin/env node
/**
 * Apply the reaction pending-decay rule (Part 6 of the entity-dedup work).
 *
 * `reactions_pending` currently sits at ~23,000 because the maturation
 * step treats "no bars" identically to "bars still catching up". Rule:
 * if the event's report date is more than 60 trading days (~90 calendar
 * days) in the past AND Yahoo has zero bars for the baseline window,
 * flip each unresolved horizon from pending → `{ status: "unavailable" }`.
 *
 * Never fabricate a number — pending stays pending whenever bars might
 * still arrive. Only genuinely-terminal cases move to unavailable.
 *
 *   node scripts/apply-reaction-decay.mjs             # write
 *   node scripts/apply-reaction-decay.mjs --dry       # report only
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const CONCURRENCY = 20;
const CALENDAR_DAY_THRESHOLD = 90; // ≈ 60 trading days
// The nightly cron's matureEventReaction only runs against events within
// a narrow window; anything older than STALE_DAY_THRESHOLD that STILL
// has all-null reaction points was never processed and never will be
// (baselines require bars in a narrow window that has since scrolled
// past). Flip those terminal-unavailable without a Yahoo bar probe —
// the "bars might still arrive" concern doesn't apply this far past
// the m1 horizon (~30d). Opt-in via --include-stale so the default
// behaviour is unchanged.
const INCLUDE_STALE = args.has("--include-stale");
const STALE_DAY_THRESHOLD = 180;

function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

// Yahoo v8 chart — same endpoint the earlier estimator-null triage used.
// A 200 with empty timestamp[] means "no bars for this symbol", which is
// the terminal condition we're checking for.
async function probeBars(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=3mo&interval=1d`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (apply-reaction-decay)" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    return { barCount: ts.length };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  console.log(`apply-reaction-decay · dry=${DRY} threshold=${CALENDAR_DAY_THRESHOLD}d`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const yahooByTicker = new Map(
    reg.entities.map((e) => [e.ticker, e.yahooSymbol ?? null]),
  );
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  console.log(`Shards to scan: ${files.length}`);

  const today = new Date();
  // Pass 1: enumerate candidates — events past the threshold with any
  // unresolved point. Group by ticker to minimize Yahoo calls.
  const candidatesByTicker = new Map();
  let pendingBefore = 0;
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    const evs = Array.isArray(j) ? j : (j.events ?? []);
    for (const ev of evs) {
      const anchor = ev.eventDate ?? ev.scheduledDate;
      if (!anchor) continue;
      const unresolved = (ev.reaction?.points ?? []).filter(
        (pt) =>
          (pt.absReturn === null || pt.absReturn === undefined) &&
          pt.status !== "unavailable",
      );
      if (unresolved.length === 0) continue;
      pendingBefore += unresolved.length;
      if (daysBetween(anchor, today) < CALENDAR_DAY_THRESHOLD) continue;
      if (!candidatesByTicker.has(ev.ticker)) {
        candidatesByTicker.set(ev.ticker, { shard: p, wrapped: !Array.isArray(j), body: j, events: evs, hits: [] });
      }
      candidatesByTicker.get(ev.ticker).hits.push(ev);
    }
  }
  console.log(
    `Candidate tickers (past threshold with unresolved points): ${candidatesByTicker.size}`,
  );
  console.log(`Pending points total (all events):                       ${pendingBefore}`);

  // Pass 2: probe Yahoo bars per candidate ticker; if empty, flip all
  // unresolved points on that ticker's past-threshold events to
  // `status: "unavailable"`.
  const tickers = [...candidatesByTicker.keys()];
  let barsEmpty = 0;
  let barsPresent = 0;
  let probeErrors = 0;
  const unavailableByTicker = new Map();
  await pool(tickers, CONCURRENCY, async (ticker, i) => {
    const sym = yahooByTicker.get(ticker);
    if (!sym) {
      // No symbol on registry — treat as terminal
      unavailableByTicker.set(ticker, true);
      barsEmpty++;
      return;
    }
    const r = await probeBars(sym);
    if (r.error) { probeErrors++; return; }
    if ((r.barCount ?? 0) === 0) {
      unavailableByTicker.set(ticker, true);
      barsEmpty++;
    } else {
      barsPresent++;
    }
    if ((i + 1) % 50 === 0) {
      console.log(
        `  probed ${i + 1}/${tickers.length} · empty=${barsEmpty} · present=${barsPresent} · err=${probeErrors}`,
      );
    }
  });

  console.log(`\nProbes complete:`);
  console.log(`  bars empty (terminal):   ${barsEmpty}`);
  console.log(`  bars present:            ${barsPresent}`);
  console.log(`  probe errors (kept pending): ${probeErrors}`);

  // Pass 3: rewrite shards that need it.
  const nowIso = new Date().toISOString();
  const shardsToWrite = new Map();
  let movedPoints = 0;
  let staleMoved = 0;
  for (const [ticker, ctx] of candidatesByTicker) {
    const tickerTerminal = unavailableByTicker.get(ticker) === true;
    for (const ev of ctx.hits) {
      // Age-based stale flip: only fires with --include-stale AND the
      // event is past STALE_DAY_THRESHOLD. This catches events that
      // never went through matureEventReaction (cron only touches
      // events near their scheduledDate; anything older is orphaned).
      const anchor = ev.eventDate ?? ev.scheduledDate;
      const ageDays = anchor ? daysBetween(anchor, today) : 0;
      const staleEligible =
        INCLUDE_STALE && ageDays >= STALE_DAY_THRESHOLD;
      if (!tickerTerminal && !staleEligible) continue;
      for (const pt of ev.reaction?.points ?? []) {
        if (
          (pt.absReturn === null || pt.absReturn === undefined) &&
          pt.status !== "unavailable"
        ) {
          pt.status = "unavailable";
          pt.computedAt = nowIso;
          movedPoints++;
          if (!tickerTerminal && staleEligible) staleMoved++;
        }
      }
    }
    shardsToWrite.set(ctx.shard, ctx.wrapped ? { ...ctx.body, events: ctx.events } : ctx.events);
  }

  const pendingAfter = pendingBefore - movedPoints;
  console.log(`\n=== Decay applied ===`);
  console.log(`Pending points before:    ${pendingBefore}`);
  console.log(`Moved to unavailable:     ${movedPoints}`);
  if (INCLUDE_STALE) {
    console.log(`  ...via age-based (--include-stale, > ${STALE_DAY_THRESHOLD}d): ${staleMoved}`);
  }
  console.log(`Pending points after:     ${pendingAfter}`);
  console.log(`Shards updated:           ${shardsToWrite.size}`);

  if (DRY) {
    console.log("\nDry run — no write.");
    return;
  }
  for (const [p, body] of shardsToWrite) {
    await fs.writeFile(p, JSON.stringify(body, null, 2));
  }
  console.log(`✓ updated ${shardsToWrite.size} shards`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
