#!/usr/bin/env node
/**
 * Emit the /sweep target-list (Tier A ∪ Tier B) as a single JSON
 * array of tickers to stdout. Used by .claude/commands/sweep.md
 * step 1 so Claude Code doesn't have to load the 12MB entity
 * registry itself.
 *
 * Tier A: data/covered.json.tickers[]  (17 hand-picked)
 * Tier B: registry entities where
 *           index_membership.includes("SP500")
 *           AND ticker.endsWith(" US")
 *           AND secFilerType !== "foreign"
 *         (~473 SP500 US-primary domestic filers)
 *
 * De-duplicates the union. Prints one JSON array:
 *   ["HBM US", "CENX US", ..., "AAPL US", "MSFT US", ...]
 *
 *   node scripts/sweep-target-list.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

async function main() {
  const reg = JSON.parse(await fs.readFile(path.join(ROOT, "data", "entity-registry.json"), "utf-8"));
  const covered = JSON.parse(await fs.readFile(path.join(ROOT, "data", "covered.json"), "utf-8"));

  const tierA = new Set(covered.tickers ?? []);
  const tierB = new Set();
  for (const e of reg.entities ?? []) {
    if (!(e.index_membership ?? []).includes("SP500")) continue;
    if (!e.ticker.endsWith(" US")) continue;
    if (e.secFilerType === "foreign") continue;
    tierB.add(e.ticker);
  }
  const union = [...new Set([...tierA, ...tierB])].sort();
  process.stdout.write(JSON.stringify(union));
}

main().catch((e) => { console.error(e); process.exit(1); });
