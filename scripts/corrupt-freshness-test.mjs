#!/usr/bin/env node
/**
 * Corruption test for the freshness.stale rule (v3).
 *
 * Sequence:
 *   1. Baseline — run pipeline check, expect stale count == baseline
 *      (usually 0) and status "ok" (or "degraded" only for pre-existing
 *      unrelated reasons that DON'T mention freshness.stale).
 *   2. Corrupt — pick 11 canonical operating non-dormant entities that
 *      are currently FRESH and shift every past-event's eventDate on
 *      each shard well back into the past (>400 days). This should
 *      push each into STALE per detect-stale-earnings logic (>7d past
 *      expected + no matching event for the expected period).
 *   3. Re-check — expect stale >= 11 AND reasons[] contains the
 *      `freshness.stale=…` string.
 *   4. Restore all touched shards from originals.
 *   5. Final — freshness.stale back to baseline; status back to prior.
 *
 *   node scripts/corrupt-freshness-test.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const CHECK = path.join(__dirname, "run-pipeline-check.mjs");

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}

function runCheck(label) {
  const out = execFileSync("node", [CHECK], { encoding: "utf-8" });
  const staleMatch = out.match(/"freshness":\s*{[^}]*"stale":\s*(\d+)/);
  const stale = staleMatch ? Number(staleMatch[1]) : null;
  const reasons = out.match(/"reasons":\s*\[[\s\S]*?\]/)?.[0]?.slice(0, 800) ?? "";
  const statusMatch = out.match(/"status":\s*"(\w+)"/);
  const status = statusMatch?.[1] ?? "?";
  console.log(`\n=== ${label} ===`);
  console.log(`  freshness.stale = ${stale}`);
  console.log(`  status = ${status}`);
  console.log(`  reasons: ${reasons}`);
  return { stale, reasons, status };
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const operating = (reg.entities ?? []).filter(
    (e) => e.securityType === "operating" && e.dormant !== true,
  );

  // Pick 11 tickers whose shard exists and has past events with real
  // actuals — those will be currently FRESH. We shift them all >400
  // days back to force STALE.
  const targets = [];
  for (const e of operating) {
    if (targets.length >= 14) break;
    const shardPath = path.join(EVENTS_DIR, tickerSlug(e.ticker) + ".json");
    let j;
    try {
      j = JSON.parse(await fs.readFile(shardPath, "utf-8"));
    } catch {
      continue;
    }
    const isArr = Array.isArray(j);
    const events = isArr ? j : j.events ?? [];
    const pastReal = events.filter(
      (ev) => ev.eventDate && (ev.metrics ?? []).some((m) => m.actual?.value != null),
    );
    if (pastReal.length < 1) continue;
    targets.push({ ticker: e.ticker, path: shardPath, wrapped: !isArr, body: j });
  }
  if (targets.length < 14) throw new Error(`Could not find 14 FRESH candidates (found ${targets.length})`);

  // Snapshot originals so we can restore verbatim on failure/finish.
  for (const t of targets) t.originalText = await fs.readFile(t.path, "utf-8");

  // 1. Baseline
  const baseline = runCheck("BASELINE");

  // 2. Corrupt — shift every past eventDate on every target ~500 days
  // back, so the expected next report is >7 days past AND no past event
  // has the expected period label. Freshness detector will classify STALE.
  const SHIFT_MS = 500 * 86_400_000;
  const shiftDate = (iso) => {
    if (!iso) return iso;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return iso;
    return new Date(t - SHIFT_MS).toISOString().slice(0, 10);
  };
  for (const t of targets) {
    const events = t.wrapped ? t.body.events : t.body;
    for (const ev of events) {
      if (ev.eventDate) ev.eventDate = shiftDate(ev.eventDate);
    }
    // Also drop any upcoming shells so the freshness detector uses the
    // shifted anchor instead of a fresh scheduledDate.
    const filtered = events.filter((ev) => ev.eventDate);
    const outBody = t.wrapped ? { ...t.body, events: filtered } : filtered;
    await fs.writeFile(t.path, JSON.stringify(outBody, null, 2));
  }
  console.log(`\n>>> Corrupted ${targets.length} shards: shifted all eventDates -500d + stripped upcoming shells`);

  const corrupted = runCheck("AFTER CORRUPTION");

  // 3. Restore verbatim
  for (const t of targets) await fs.writeFile(t.path, t.originalText);
  console.log(`\n>>> Restored ${targets.length} shards`);

  const restored = runCheck("AFTER RESTORE");

  // Assertions
  console.log("\n=== RESULT ===");
  console.log(`  baseline stale:            ${baseline.stale}`);
  console.log(`  after-corruption stale:    ${corrupted.stale}`);
  console.log(`  after-restore stale:       ${restored.stale}`);
  // Rule is `stale > 10` so we need >10 after corruption. We corrupted
  // 14 shards; not every one classifies to STALE (some may fall into
  // SHELL_ONLY if the corrupted anchor happens to look like a shell).
  // Require: (a) stale > 10, (b) reasons cite freshness.stale.
  const rose = (corrupted.stale ?? 0) > 10;
  const back = restored.stale === baseline.stale;
  const flagged = /freshness\.stale=/.test(corrupted.reasons);
  const degradedNow = corrupted.status === "degraded";
  console.log(`  stale > 10?                ${rose}`);
  console.log(`  reason cited in reasons[]? ${flagged}`);
  console.log(`  status flipped to degraded?${degradedNow}`);
  console.log(`  restored to baseline?      ${back}`);
  if (rose && back && flagged && degradedNow) {
    console.log("\n✓ Freshness corruption test PASSED — stale>10 rule fires + clears.");
    process.exit(0);
  } else {
    console.log("\n✗ Freshness corruption test FAILED.");
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
