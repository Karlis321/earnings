#!/usr/bin/env node
/**
 * Emit the /sweep target-list as a single JSON array of tickers to
 * stdout. Used by .claude/commands/sweep.md step 1.
 *
 * SCOPE = "all" (default): every operating, non-dormant, non-foreign-
 *   filer entity in the registry (~2,900 US + international). Only
 *   ~5-40 report per week so /sweep's "reported in last 5 trading
 *   days AND no summary yet" filter keeps actual work bounded — the
 *   candidate pool is just the universe.
 *
 * SCOPE = "indexed" (env SCOPE=indexed): Tier A ∪ B ∪ C — the covered
 *   17 + SP500 domestic + R1000 domestic (~1,000 US-primary filers).
 *   Kept as an option for cost-bounding when the sweep runner budget
 *   is tight.
 *
 * Tier A: data/covered.json.tickers[]  (17 hand-picked)
 * Tier B: SP500 US-primary domestic filers
 * Tier C: R1000 US-primary domestic filers
 *
 *   node scripts/sweep-target-list.mjs
 *   SCOPE=indexed node scripts/sweep-target-list.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SCOPE = process.env.SCOPE === "indexed" ? "indexed" : "all";

async function main() {
  const reg = JSON.parse(await fs.readFile(path.join(ROOT, "data", "entity-registry.json"), "utf-8"));
  const covered = JSON.parse(await fs.readFile(path.join(ROOT, "data", "covered.json"), "utf-8"));

  const tierA = new Set(covered.tickers ?? []);
  const set = new Set([...tierA]);

  for (const e of reg.entities ?? []) {
    // Same-shape filters both scopes use — skip non-operating,
    // dormant, ETF, and foreign-primary listings (they file via
    // 6-K/20-F; their document rule follows the home venue).
    if (e.securityType !== "operating") continue;
    if (e.dormant) continue;
    if (e.secFilerType === "foreign") continue;
    if (e.secFilerType === "pre-listing") continue;

    if (SCOPE === "indexed") {
      // Tier B + Tier C — SP500 or R1000 US-primary domestic.
      if (!e.ticker.endsWith(" US")) continue;
      const mem = e.index_membership ?? [];
      if (mem.includes("SP500") || mem.includes("R1000")) set.add(e.ticker);
    } else {
      // scope=all — every operating, non-dormant, non-foreign,
      // non-pre-listing entity. Includes US primaries + foreign
      // primaries whose /earnings can run against IR pages or
      // publicly-available filings (not just SEC 10-Q). The
      // /earnings command's Step-1 source ladder is smart enough
      // to route by venue.
      set.add(e.ticker);
    }
  }
  const union = [...set].sort();
  process.stdout.write(JSON.stringify(union));
}

main().catch((e) => { console.error(e); process.exit(1); });
