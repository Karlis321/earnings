#!/usr/bin/env node
/**
 * For every operating entity with an EMPTY shard, find a sibling in
 * the same companyId that has events, and copy them (rewriting the
 * ticker to the empty listing's). Same principle as SEC-verbatim rule:
 * all listings of one company share the same underlying financials.
 *
 * Runs AFTER refresh-yahoo-shards.mjs + fill-sec-empty-shards.mjs so
 * we only pick up truly-stranded tickers.
 *
 *   node scripts/inherit-from-siblings.mjs [--dry]
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

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}

function shardPastCount(shardPath) {
  try {
    const j = JSON.parse(fssync.readFileSync(shardPath, "utf-8"));
    const evs = Array.isArray(j) ? j : j.events ?? [];
    return evs.filter((e) => e.eventDate).length;
  } catch { return 0; }
}
function readShardEvents(shardPath) {
  try {
    const j = JSON.parse(fssync.readFileSync(shardPath, "utf-8"));
    return Array.isArray(j) ? j : j.events ?? [];
  } catch { return []; }
}

async function main() {
  console.log(`inherit-from-siblings · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];

  // Group by companyId. For each group, find members with content vs empty.
  const byCompany = new Map();
  for (const e of entities) {
    if (!e.companyId) continue;
    if (e.securityType !== "operating") continue;
    if (!byCompany.has(e.companyId)) byCompany.set(e.companyId, []);
    byCompany.get(e.companyId).push(e);
  }

  const nowIso = new Date().toISOString();
  const rollup = {
    schema: "inherit-from-siblings/v1",
    generatedAt: nowIso,
    totals: {
      companiesScanned: byCompany.size,
      emptyTickersFound: 0,
      inherited: 0,
      noSiblingWithData: 0,
      shardsWritten: 0,
      eventsCopied: 0,
    },
    perTicker: [],
  };

  for (const [cid, members] of byCompany) {
    if (members.length < 2) continue; // single-listing companies can't inherit
    // Find the richest sibling (most events) as the source.
    let bestSibling = null;
    let bestEvents = [];
    for (const m of members) {
      const p = path.join(EVENTS_DIR, tickerSlug(m.ticker) + ".json");
      const evs = readShardEvents(p).filter((e) => e.eventDate);
      if (evs.length > bestEvents.length) {
        bestSibling = m;
        bestEvents = evs;
      }
    }
    if (!bestSibling || bestEvents.length === 0) continue;

    // Copy to each empty sibling.
    for (const m of members) {
      if (m.ticker === bestSibling.ticker) continue;
      const p = path.join(EVENTS_DIR, tickerSlug(m.ticker) + ".json");
      const cur = readShardEvents(p).filter((e) => e.eventDate);
      if (cur.length > 0) continue; // already has data
      rollup.totals.emptyTickersFound++;
      const cloned = bestEvents.map((ev) => ({
        ...ev,
        id: hashId(`${m.ticker}_${ev.eventDate}_${ev.period ?? ""}`),
        ticker: m.ticker,
        // Reset reaction — benchmark may differ per listing (US SPX vs EU DAX etc.)
        reaction: {
          benchmark: m.benchmark ?? bestSibling.benchmark ?? "SPX",
          baselineDate: null,
          baselineClose: null,
          points: (ev.reaction?.points ?? []).map((pt) => ({
            horizon: pt.horizon,
            absReturn: null,
            excessReturn: null,
            benchmark: m.benchmark ?? "SPX",
            computedAt: null,
            populatesOn: pt.populatesOn,
          })),
        },
      }));
      if (!DRY) {
        fssync.writeFileSync(p, JSON.stringify({ events: cloned }, null, 2));
      }
      rollup.totals.inherited++;
      rollup.totals.shardsWritten++;
      rollup.totals.eventsCopied += cloned.length;
      rollup.perTicker.push({
        ticker: m.ticker,
        cid,
        sourceSibling: bestSibling.ticker,
        eventsCopied: cloned.length,
      });
    }
  }

  console.log(`\n=== inherit-from-siblings ===`);
  console.log(`Companies with ≥2 members:  ${rollup.totals.companiesScanned}`);
  console.log(`Empty tickers inherited:    ${rollup.totals.inherited}`);
  console.log(`Shards written:             ${rollup.totals.shardsWritten}`);
  console.log(`Events copied total:        ${rollup.totals.eventsCopied}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "inherit-from-siblings.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/inherit-from-siblings.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
