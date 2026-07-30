#!/usr/bin/env node
/**
 * Task 2 — Re-ingest the 15 emptied shards.
 *
 * Last session emptied these US-canonical shards to keep the
 * cross-listing invariant clean after a yahoo-timeseries backfill
 * created values that diverged from the sibling foreign-wrapper
 * shard's SEC-verbatim history. Empty canonical listings are not
 * acceptable — the fix is to copy the sibling's SEC-verbatim events
 * onto the US canonical (all listings under the same companyId
 * already carry identical facts via secVerbatim.ts).
 *
 * Approach: for each emptied US shard, find another shard belonging
 * to the same companyId and clone its past events, rewriting the
 * ticker to the US canonical. If no sibling has events either,
 * stamp the entity with dataStatus:"unpopulatable" + reason and
 * leave the shard empty.
 *
 *   node scripts/reingest-emptied-shards.mjs [--dry]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");
const EMPTIED = [
  "ARKO US", "AVX US", "BWA US", "COST US", "DIS US", "DTE US",
  "ECG US", "EGO US", "ICE US", "NVDA US", "PSN US", "SBUX US",
  "SMTC US", "TEL US", "WMT US",
];

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function hashId(s) {
  let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}

async function main() {
  console.log(`reingest-emptied-shards · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byCo = new Map();
  for (const e of reg.entities || []) {
    if (!e.companyId) continue;
    if (!byCo.has(e.companyId)) byCo.set(e.companyId, []);
    byCo.get(e.companyId).push(e);
  }

  const results = [];
  for (const usTicker of EMPTIED) {
    const usEntity = (reg.entities || []).find((e) => e.ticker === usTicker);
    if (!usEntity) { results.push({ ticker: usTicker, status: "entity-missing" }); continue; }
    const siblings = (byCo.get(usEntity.companyId) || []).filter((m) => m.ticker !== usTicker);

    // Find the sibling shard with the most past events.
    let bestSibling = null;
    let bestEvents = [];
    for (const s of siblings) {
      const p = path.join(EVENTS_DIR, tickerSlug(s.ticker) + ".json");
      try {
        const j = JSON.parse(await fs.readFile(p, "utf-8"));
        const evs = Array.isArray(j) ? j : j.events || [];
        const past = evs.filter((e) => e.eventDate);
        if (past.length > bestEvents.length) {
          bestSibling = s.ticker;
          bestEvents = past;
        }
      } catch { /* no shard for that sibling */ }
    }

    if (bestEvents.length === 0) {
      results.push({ ticker: usTicker, status: "unpopulatable", reason: "no sibling has past events", cid: usEntity.companyId });
      // Stamp the entity as unpopulatable so the UI renders honestly.
      usEntity.dataStatus = "unpopulatable";
      usEntity.dataStatusReason = "no SEC or vendor source available across any listing";
      usEntity.dataStatusAsOf = new Date().toISOString();
      continue;
    }

    // Clone events, rewriting ticker + id so shard reads route correctly.
    const cloned = bestEvents.map((ev) => ({
      ...ev,
      id: hashId(`${usTicker}_${ev.eventDate}_${ev.period ?? ""}`),
      ticker: usTicker,
      // Reaction was computed against the sibling's benchmark — reset it
      // for the US canonical since its benchmark may differ (default SPX
      // for US-listed; foreign wrapper may have had IBOV/FTSE/etc).
      reaction: {
        benchmark: usEntity.benchmark ?? "SPX",
        baselineDate: null,
        baselineClose: null,
        points: (ev.reaction?.points ?? []).map((p) => ({
          horizon: p.horizon,
          absReturn: null,
          excessReturn: null,
          benchmark: usEntity.benchmark ?? "SPX",
          computedAt: null,
          populatesOn: p.populatesOn,
        })),
      },
    }));

    if (!DRY) {
      const outPath = path.join(EVENTS_DIR, tickerSlug(usTicker) + ".json");
      await fs.writeFile(outPath, JSON.stringify({ events: cloned }, null, 2));
    }
    results.push({
      ticker: usTicker,
      status: "reingested",
      sourceSibling: bestSibling,
      events: cloned.length,
      cid: usEntity.companyId,
    });
  }

  if (!DRY) {
    await fs.writeFile(REG_PATH, JSON.stringify(reg, null, 2) + "\n");
  }

  const summary = {
    reingested: results.filter((r) => r.status === "reingested").length,
    unpopulatable: results.filter((r) => r.status === "unpopulatable").length,
    entityMissing: results.filter((r) => r.status === "entity-missing").length,
  };
  console.log("=== reingest-emptied-shards ===");
  console.log(`reingested:    ${summary.reingested}`);
  console.log(`unpopulatable: ${summary.unpopulatable}`);
  console.log(`entity-missing: ${summary.entityMissing}`);
  console.log("");
  for (const r of results) {
    if (r.status === "reingested") {
      console.log(`  ${r.ticker.padEnd(10)} ← ${r.sourceSibling.padEnd(12)} (${r.events} events)`);
    } else {
      console.log(`  ${r.ticker.padEnd(10)} [${r.status}] ${r.reason ?? ""}`);
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const auditPath = path.join(OUT_DIR, "reingest-emptied.json");
  await fs.writeFile(auditPath, JSON.stringify({
    schema: "reingest-emptied/v1",
    generatedAt: new Date().toISOString(),
    summary,
    per_ticker: results,
  }, null, 2));
  console.log(`✓ audit → ${auditPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
