#!/usr/bin/env node
/**
 * Apply the entity-group audit to the registry (Part 2 of the dedup
 * work). Reads scripts/audits/entity-groups.json, stamps every entity
 * with:
 *
 *   companyId          — stable id per company (co-{7-char hash of
 *                        the canonical ticker})
 *   isCanonical        — true for exactly one member per company
 *   industryGroup      — inherited from the canonical member if the
 *                        entity is missing it
 *   industryGroupSource— "direct" (already had it) | "inherited"
 *
 * Singletons (entities NOT in any group from the audit) each get their
 * own companyId with themselves as canonical. Result: every entity has
 * a companyId after this runs.
 *
 * canonicalOverrides — optional companyId → ticker map for edge cases
 * where the auto-picked canonical is wrong (e.g. NVIDIA where the US
 * primary listing isn't in the registry). Config at
 * scripts/config/canonical-overrides.json (optional file).
 *
 *   node scripts/apply-entity-groups.mjs             # write
 *   node scripts/apply-entity-groups.mjs --dry       # report only
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const AUDIT = path.join(ROOT, "scripts", "audits", "entity-groups.json");
const OVERRIDES = path.join(ROOT, "scripts", "config", "canonical-overrides.json");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");

// Stable id: deterministic hash of the canonical ticker. Same canonical
// → same companyId every run, so re-applying is idempotent. Uses SHA-1
// (10-char hex prefix, ~40 bits) rather than the naive djb2×36 slice —
// 7-char base36 gave one collision at 1,867 entities (2C6 GR / 2BU GR).
import { createHash } from "node:crypto";
function companyIdOf(canonicalTicker) {
  const h = createHash("sha1").update(canonicalTicker).digest("hex").slice(0, 10);
  return "co-" + h;
}

async function readJsonOr(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, "utf-8")); } catch { return fallback; }
}

async function main() {
  console.log(`apply-entity-groups · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const audit = await readJsonOr(AUDIT, null);
  if (!audit) {
    console.error(
      `No audit file at ${AUDIT}. Run scripts/detect-entity-groups.mjs first.`,
    );
    process.exit(1);
  }
  const overrides = (await readJsonOr(OVERRIDES, {})).overrides ?? {};
  console.log(
    `Registry: ${reg.entities.length} entities · audit groups: ${audit.groups.length} · overrides: ${Object.keys(overrides).length}`,
  );

  const byTicker = new Map(reg.entities.map((e) => [e.ticker, e]));
  const assigned = new Set();

  // Apply audit groups. Overrides let us hand-pick a canonical member
  // when the auto-picker chose poorly (e.g. NVIDIA→NVDC34 BZ because
  // NVDA US isn't in the registry). Override lookup key is the auto
  // canonical from the audit.
  let groupsApplied = 0;
  let inheritedIndustry = 0;
  for (const g of audit.groups) {
    const canonicalTicker =
      overrides[g.canonical] ?? g.canonical;
    const companyId = companyIdOf(canonicalTicker);
    // Build the ordered member list; the canonical must exist in the group.
    const members = g.members
      .map((m) => byTicker.get(m.ticker))
      .filter(Boolean);
    if (members.length === 0) continue;
    // Find the canonical entity — the ticker matching `canonicalTicker`.
    // If the override points at a ticker outside the group members, fall
    // back to the audit's canonical (a warning is enough — we don't halt).
    let canonicalEntity = members.find((e) => e.ticker === canonicalTicker);
    if (!canonicalEntity) {
      console.warn(
        `  override for ${g.canonical} → ${canonicalTicker} not in group members; using auto pick`,
      );
      canonicalEntity = members.find((e) => e.ticker === g.canonical) ?? members[0];
    }

    // Industry-group inheritance: canonical's value propagates to members
    // that don't have one. If the canonical itself has none, look for
    // any member with an industryGroup and adopt that as the group's
    // authoritative value.
    let groupIndustry = canonicalEntity.industryGroup ?? null;
    if (!groupIndustry) {
      const other = members.find((e) => e.industryGroup);
      if (other) groupIndustry = other.industryGroup ?? null;
    }
    for (const m of members) {
      m.companyId = companyId;
      m.isCanonical = m.ticker === canonicalEntity.ticker;
      if (!m.industryGroup && groupIndustry) {
        m.industryGroup = groupIndustry;
        m.industryGroupSource = "inherited";
        m.industryGroupAsOf =
          canonicalEntity.industryGroupAsOf ?? new Date().toISOString();
        inheritedIndustry++;
      } else if (m.industryGroup && !m.industryGroupSource) {
        m.industryGroupSource = "direct";
      }
      assigned.add(m.ticker);
    }
    groupsApplied++;
  }

  // Singletons: each ungrouped entity gets its own companyId + isCanonical=true.
  let singletons = 0;
  for (const e of reg.entities) {
    if (assigned.has(e.ticker)) continue;
    e.companyId = companyIdOf(e.ticker);
    e.isCanonical = true;
    if (e.industryGroup && !e.industryGroupSource) {
      e.industryGroupSource = "direct";
    }
    singletons++;
  }

  // Coverage totals
  const unclassified = reg.entities.filter((e) => !e.industryGroup);
  const withDirect = reg.entities.filter(
    (e) => e.industryGroupSource === "direct",
  );
  const withInherited = reg.entities.filter(
    (e) => e.industryGroupSource === "inherited",
  );
  const companyCount = new Set(reg.entities.map((e) => e.companyId)).size;
  const canonicalCount = reg.entities.filter((e) => e.isCanonical).length;

  console.log(`\n=== Applied ===`);
  console.log(`Groups applied:                  ${groupsApplied}`);
  console.log(`Entities assigned to groups:     ${assigned.size}`);
  console.log(`Singleton companies (self-only): ${singletons}`);
  console.log(`Total companies:                 ${companyCount}`);
  console.log(`Canonical entities:              ${canonicalCount}  (should == ${companyCount})`);
  console.log(`\n=== Industry-group coverage ===`);
  console.log(`  direct (Yahoo assetProfile):   ${withDirect.length}`);
  console.log(`  inherited (from canonical):    ${withInherited.length}  (+${inheritedIndustry} this run)`);
  console.log(`  still unclassified:            ${unclassified.length}`);

  if (DRY) {
    console.log("\nDry run — no write.");
    return;
  }
  await fs.writeFile(REGISTRY, JSON.stringify(reg, null, 2));
  console.log(`\n✓ wrote ${REGISTRY}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
