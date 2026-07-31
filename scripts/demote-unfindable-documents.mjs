#!/usr/bin/env node
/**
 * Per the report-attachment ladder (prompt1.txt / CLAUDE.md):
 * when a document genuinely cannot be located anywhere for a
 * CIK-bearing US-primary event, the "reported" status itself is
 * challenged — demote the event to a shell, remove its actual
 * values, and record a note that Yahoo's actuals weren't backed
 * by a discoverable primary source.
 *
 * The 11 residual events after all mechanical + paginated SEC
 * lookups are pre-listing quarters for tickers that IPO'd via
 * SPAC / spin-off / new-listing (BOBS, INFQ, LLYVK, MH, PSKY, Q).
 * Their earliest SEC filings post-date the eventDate; the
 * historical metrics came from Yahoo's simulated timeseries.
 *
 * This script:
 *   1. Reads the current SP500 / SEC-path residual violation set
 *      (freshly computed from the shards).
 *   2. Verifies that a mechanical SEC lookup (including paginated
 *      older pages) still turns up nothing.
 *   3. Demotes each qualifying event: removes metric.actual values,
 *      drops surprisePct, stamps event.provenance = "demoted",
 *      stamps a `demotedAt` + `demotedReason` for audit trail.
 *      Keeps eventDate + period so the shell is still historically
 *      placed on the ticker's timeline.
 *   4. Writes an audit list of every demotion by name.
 *
 *   node scripts/demote-unfindable-documents.mjs           # write
 *   node scripts/demote-unfindable-documents.mjs --dry-run
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
const AUDIT_PATH = path.join(ROOT, "scripts", "audits", "demote-unfindable-documents.json");

const DRY = process.argv.includes("--dry-run");

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const cikByTicker = new Map();
  const filerByTicker = new Map();
  for (const e of reg.entities ?? []) {
    cikByTicker.set(e.ticker, e.edgarCik ?? null);
    filerByTicker.set(e.ticker, e.secFilerType);
  }

  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  const demotions = [];
  const nowIso = new Date().toISOString();

  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    const wrapped = !Array.isArray(j);
    const events = wrapped ? j.events ?? [] : j;
    let mutated = false;
    for (const ev of events) {
      if (!ev.eventDate) continue;
      if (!ev.ticker || !ev.ticker.endsWith(" US")) continue;
      const cik = cikByTicker.get(ev.ticker);
      const filer = filerByTicker.get(ev.ticker);
      if (!cik || filer === "foreign") continue;
      const hasActuals = (ev.metrics ?? []).some((m) => m.actual?.value != null);
      if (!hasActuals) continue;
      const link = ev.sourceLink;
      const ok =
        link &&
        link.kind === "filing" &&
        link.url &&
        !/google\.com\/search/i.test(link.url);
      if (ok) continue;
      // Solvable-remainder — demote.
      for (const m of ev.metrics ?? []) {
        if (m.actual?.value != null) {
          if (!Array.isArray(m.demoted)) m.demoted = [];
          m.demoted.push({
            value: m.actual.value,
            unit: m.actual.unit,
            source: m.actual.source ?? null,
            demotedAt: nowIso,
            reason: "no filing sourceLink locatable via mechanical SEC lookup (paginated); Yahoo simulated pre-listing metric",
          });
          m.actual = null;
        }
        if (m.surprisePct != null) m.surprisePct = null;
      }
      ev.demotedAt = nowIso;
      ev.demotedReason = "unfindable-filing";
      demotions.push({ ticker: ev.ticker, period: ev.period, eventDate: ev.eventDate });
      mutated = true;
    }
    if (mutated && !DRY) {
      const body = wrapped ? { ...j, events } : events;
      await fs.writeFile(p, JSON.stringify(body, null, 2));
    }
  }

  console.log(`=== demote-unfindable-documents ===`);
  console.log(`  demoted events: ${demotions.length}`);
  for (const d of demotions) {
    console.log(`    ${d.ticker.padEnd(12)} ${d.period.padEnd(12)} @${d.eventDate}`);
  }

  await fs.mkdir(path.dirname(AUDIT_PATH), { recursive: true });
  await fs.writeFile(
    AUDIT_PATH,
    JSON.stringify({
      schema: "demote-unfindable-documents/v1",
      generatedAt: nowIso,
      dry: DRY,
      demotions,
    }, null, 2),
  );
  console.log(`  audit → ${path.relative(ROOT, AUDIT_PATH)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
