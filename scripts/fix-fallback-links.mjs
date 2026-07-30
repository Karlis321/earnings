#!/usr/bin/env node
/**
 * Yahoo dropped coverage on most Asian/foreign listings. The
 * fallback sourceLinks that pointed at
 *   https://finance.yahoo.com/quote/{foreign-sym}/financials
 * now 404 across the board (verified: 30/30 sampled).
 *
 * Fix:
 *   - Filing-kind links (sec.gov) stay as-is — 15/15 verified OK.
 *   - Fallback-kind links get rewritten to a Google search URL:
 *       https://www.google.com/search?q=%22TICKER%22+%22PERIOD%22+earnings
 *     which always resolves and lands the user on real results for
 *     the exact ticker + period rather than a dead Yahoo page.
 *
 *   node scripts/fix-fallback-links.mjs [--dry]
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

// Convert "FY2026 Q1" → "Q1 2026" — Google searches for the natural
// journalism phrasing ("Company Q1 2026 earnings") return actual
// hits; the raw fiscal-year label ("FY2026 Q1" in quotes) is a
// pattern nobody in the press uses. If period isn't quarterly (e.g.
// FY2025 full-year) just drop it from the query.
function humanQuarter(period) {
  const m = /^FY(\d{4})\s*Q([1-4])$/.exec(period ?? "");
  if (!m) return null;
  return `Q${m[2]} ${m[1]}`;
}

function buildGoogleQuery(entity, event) {
  // No quoted-token constraints — Google treats quoted "TNZ CN" as
  // an exact match, and nobody writes Bloomberg codes in article
  // text. Prefer the human company name + human-readable quarter +
  // year alongside 'earnings' + 'results' so Google matches press
  // release language.
  const parts = [];
  if (entity.displayName) parts.push(entity.displayName);
  else parts.push(entity.ticker); // fallback if displayName missing
  const hq = humanQuarter(event.period);
  if (hq) parts.push(hq);
  else if (event.eventDate) parts.push(event.eventDate.slice(0, 4)); // year only
  parts.push("earnings results");
  const q = parts.join(" ").trim();
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

async function main() {
  console.log(`fix-fallback-links · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);

  const rollup = {
    schema: "fix-fallback-links/v1",
    generatedAt: new Date().toISOString(),
    totals: {
      shardsRead: 0,
      shardsWritten: 0,
      events: 0,
      rewrittenToGoogle: 0,
      keptFilingSecGov: 0,
      keptOtherFilingHost: 0,
      skippedNoEntity: 0,
    },
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
      rollup.totals.events++;
      const link = e.sourceLink;
      if (!link?.url) continue;

      if (link.kind === "filing") {
        if (/sec\.gov/i.test(link.url)) rollup.totals.keptFilingSecGov++;
        else rollup.totals.keptOtherFilingHost++;
        continue;
      }

      const entity = byTicker.get(e.ticker);
      if (!entity) { rollup.totals.skippedNoEntity++; continue; }

      // Rewrite Yahoo fallback URLs (dead) AND older Google URLs that
      // used quoted Bloomberg-code tokens (empty search results). Skip
      // non-Yahoo, non-Google fallback links — those may still resolve
      // (IR pages, EDGAR fallbacks etc.).
      const isYahoo = /finance\.yahoo\.com/i.test(link.url);
      const isOldGoogle =
        /google\.com\/search/i.test(link.url) &&
        /%22[A-Z0-9]{1,6}%20[A-Z]{2}%22/.test(link.url); // "TICKER CC" quoted
      if (!isYahoo && !isOldGoogle) continue;

      e.sourceLink = {
        url: buildGoogleQuery(entity, e),
        kind: "fallback",
      };
      rollup.totals.rewrittenToGoogle++;
    }

    const nextJson = JSON.stringify(events);
    if (nextJson !== originalJson && !DRY) {
      const body = wrapped ? { ...shard, events } : events;
      fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }
  }

  console.log(`\n=== fix-fallback-links ===`);
  console.log(`Shards read:              ${rollup.totals.shardsRead}`);
  console.log(`Shards written:           ${rollup.totals.shardsWritten}`);
  console.log(`Events scanned:           ${rollup.totals.events}`);
  console.log(`Kept SEC filing:          ${rollup.totals.keptFilingSecGov}`);
  console.log(`Kept other filing host:   ${rollup.totals.keptOtherFilingHost}`);
  console.log(`Rewritten → Google:       ${rollup.totals.rewrittenToGoogle}`);
  console.log(`Skipped (no entity):      ${rollup.totals.skippedNoEntity}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "fix-fallback-links.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/fix-fallback-links.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
