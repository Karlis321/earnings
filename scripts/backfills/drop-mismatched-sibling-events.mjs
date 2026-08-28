#!/usr/bin/env node
/**
 * Drop cross-listing sibling events whose revenue value diverges
 * from the majority (or from the highest-preference sibling when
 * no ≥2 majority exists).
 *
 * WHY THIS EXISTS
 * ---------------
 * For companies whose siblings ALL live outside SEC's XBRL corpus
 * (e.g. TotalEnergies, Novo Nordisk, Figma, Arko, AES on their
 * foreign wrapper listings) the daily Yahoo re-ingest keeps
 * producing revenue numbers that diverge across listings — different
 * FX conversions, different quarter-vs-half labels, sometimes just
 * plain vendor drift. The SEC-verbatim rule can't fix this because
 * there's no SEC filing to anchor against.
 *
 * The `companies_with_inconsistent_financials` invariant then fires
 * on every fresh refresh. Historically the fix has been to drop the
 * minority-valued events on the diverging sibling and keep the
 * value shared by the majority (or, when only 2 siblings disagree,
 * the one with higher preference).
 *
 * PREFERENCE RANKING (used when no ≥2-sibling majority exists):
 *   1. edgarCik-bearing entity > non-CIK
 *   2. canonical > non-canonical
 *   3. longer per-shard history > shorter
 *
 * IDEMPOTENT: does nothing when siblings already agree.
 *
 *   node scripts/backfills/drop-mismatched-sibling-events.mjs --dry
 *   node scripts/backfills/drop-mismatched-sibling-events.mjs
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const AUDIT = path.join(ROOT, "scripts", "audits", "drop-mismatched-sibling-events.json");

const DRY = process.argv.includes("--dry");

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byCid = new Map();
  for (const e of reg.entities ?? []) {
    if (!e.companyId) continue;
    if (!byCid.has(e.companyId)) byCid.set(e.companyId, []);
    byCid.get(e.companyId).push(e);
  }

  const audit = {
    schema: "drop-mismatched-sibling-events/v1",
    generatedAt: new Date().toISOString(),
    dry: DRY,
    totals: { companies_examined: 0, companies_with_drops: 0, events_dropped: 0, shards_written: 0 },
    drops: [],
  };

  for (const [cid, members] of byCid) {
    if (members.length < 2) continue;
    audit.totals.companies_examined++;

    const shards = new Map();
    for (const m of members) {
      const slug = tickerSlug(m.ticker);
      const p = path.join(EVENTS_DIR, slug + ".json");
      try {
        const s = JSON.parse(await fs.readFile(p, "utf-8"));
        const wrapped = !Array.isArray(s);
        const events = wrapped ? (s.events ?? []) : s;
        shards.set(m.ticker, { shardPath: p, body: s, wrapped, events, entity: m });
      } catch {}
    }

    const preference = (t) => {
      const meta = shards.get(t);
      if (!meta) return 0;
      let score = meta.events.filter((e) => e.eventDate).length;
      if (meta.entity?.edgarCik) score += 10000;
      if (meta.entity?.isCanonical) score += 1000;
      return score;
    };

    // Group revenue-carrying events by (period + unit) so we compare
    // apples to apples (mixing currencies would create false drops).
    const byKey = new Map();
    for (const [ticker, { events }] of shards) {
      for (const ev of events) {
        if (!ev.eventDate || !ev.period) continue;
        const rev = (ev.metrics ?? []).find((x) => x.key === "revenue_usd_m")?.actual;
        if (!rev || rev.value == null || !rev.unit) continue;
        const k = ev.period + "|" + rev.unit;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push({ ticker, rev: rev.value, evRef: ev, period: ev.period, unit: rev.unit });
      }
    }

    const mutated = new Set();
    let companyDrops = 0;
    for (const [key, entries] of byKey) {
      if (entries.length < 2) continue;
      const unique = new Set(entries.map((e) => Math.round(e.rev)));
      if (unique.size < 2) continue;

      // Cluster by rounded value.
      const buckets = new Map();
      for (const e of entries) {
        const k = String(Math.round(e.rev));
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(e);
      }
      const bucketArr = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
      const majBucket = bucketArr[0][1];

      let winnerRev;
      if (majBucket.length >= 2) {
        winnerRev = majBucket[0].rev;
      } else {
        entries.sort((a, b) => preference(b.ticker) - preference(a.ticker));
        winnerRev = entries[0].rev;
      }

      for (const e of entries) {
        if (Math.round(e.rev) === Math.round(winnerRev)) continue;
        const meta = shards.get(e.ticker);
        const idx = meta.events.indexOf(e.evRef);
        if (idx >= 0) {
          meta.events.splice(idx, 1);
          audit.totals.events_dropped++;
          companyDrops++;
          mutated.add(e.ticker);
          audit.drops.push({
            companyId: cid,
            ticker: e.ticker,
            period: e.period,
            unit: e.unit,
            droppedValue: e.rev,
            keptValue: winnerRev,
          });
        }
      }
    }

    if (companyDrops > 0) audit.totals.companies_with_drops++;

    if (!DRY) {
      for (const t of mutated) {
        const m = shards.get(t);
        const body = m.wrapped ? { ...m.body, events: m.events } : m.events;
        fssync.writeFileSync(m.shardPath, JSON.stringify(body, null, 2));
        audit.totals.shards_written++;
      }
    }
  }

  await fs.writeFile(AUDIT, JSON.stringify(audit, null, 2));

  console.log(`\n=== done ===`);
  console.log(`  companies examined:  ${audit.totals.companies_examined}`);
  console.log(`  companies with drops: ${audit.totals.companies_with_drops}`);
  console.log(`  events dropped:       ${audit.totals.events_dropped}`);
  console.log(`  shards written:       ${audit.totals.shards_written}`);
  console.log(`  audit → ${path.relative(ROOT, AUDIT)}`);
  if (audit.drops.length > 0) {
    console.log(`\n  first 10 drops:`);
    for (const d of audit.drops.slice(0, 10)) {
      console.log(`    ${d.ticker.padEnd(12)} · ${d.period} [${d.unit}] rev=${d.droppedValue} (kept:${d.keptValue})`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
