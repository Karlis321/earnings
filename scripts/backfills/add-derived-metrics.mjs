#!/usr/bin/env node
/**
 * Task 2 step 3: compute derived metrics from reported ones. All carry
 * `derived: true` inside metric.actual (rendered visually distinct so
 * analysts see what the company reported vs what we computed).
 *
 * Rules (from prompt):
 *   - FCF = OCF − capex, only when BOTH source-present (both metrics
 *     stored on the same event).
 *   - gross margin = gross_profit / revenue  (0..1)
 *   - operating margin = operating_income / revenue
 *   - net margin = net_income / revenue
 *   Never compute EBITDA silently (only if source-reported — that's an
 *   extractor concern, not a derived-metric concern).
 *
 *   node scripts/add-derived-metrics.mjs --dry
 *   node scripts/add-derived-metrics.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");

const DERIVED_SPECS = [
  {
    key: "fcf_usd_m",
    displayLabel: "Free cash flow (M)",
    inputs: ["operating_cash_flow_usd_m", "capex_usd_m"],
    compute: (o, c) => o - c, // capex is typically POSITIVE (a cash outflow value); FCF = OCF - capex
    unitFrom: (o) => o.unit ?? "USD",
  },
  {
    key: "gross_margin_pct",
    displayLabel: "Gross margin",
    inputs: ["gross_profit_usd_m", "revenue_usd_m"],
    compute: (g, r) => (r === 0 ? null : g / r),
    unitFrom: () => "%",
  },
  {
    key: "operating_margin_pct",
    displayLabel: "Operating margin",
    inputs: ["operating_income_usd_m", "revenue_usd_m"],
    compute: (o, r) => (r === 0 ? null : o / r),
    unitFrom: () => "%",
  },
  {
    key: "net_margin_pct",
    displayLabel: "Net margin",
    inputs: ["net_income_usd_m", "revenue_usd_m"],
    compute: (n, r) => (r === 0 ? null : n / r),
    unitFrom: () => "%",
  },
  // Total debt = long-term + short-term components. SEC-verbatim stores the
  // pieces separately (long_term_debt_usd_m + short_term_debt_usd_m); this
  // derived roll-up avoids "silent sum" of components under a single
  // long_term_debt label. CLAUDE.md rule: never invented, never presented
  // as reported — the derived badge makes it explicit.
  {
    key: "total_debt_usd_m",
    displayLabel: "Total debt (M)",
    inputs: ["long_term_debt_usd_m", "short_term_debt_usd_m"],
    compute: (l, s) => l + s,
    unitFrom: (l) => l.unit ?? "USD",
  },
  // Net debt = total debt - total cash. Only computed when BOTH sides
  // present (no fallback to gross debt).
  {
    key: "net_debt_usd_m",
    displayLabel: "Net debt (M)",
    inputs: ["long_term_debt_usd_m", "short_term_debt_usd_m", "total_cash_usd_m"],
    compute: (l, s, c) => l + s - c,
    unitFrom: (l) => l.unit ?? "USD",
  },
];

async function main() {
  console.log(`add-derived-metrics · dry=${DRY}`);
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  let touched = 0;
  let added = 0;
  const shardBodies = new Map();

  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    const wrapped = !Array.isArray(j);
    const evs = wrapped ? (j.events ?? []) : j;
    shardBodies.set(p, { wrapped, body: j, events: evs });
    let shardDirty = false;
    for (const ev of evs) {
      if (!ev.eventDate) continue;
      const now = new Date().toISOString();
      for (const spec of DERIVED_SPECS) {
        if ((ev.metrics ?? []).some((m) => m.key === spec.key)) continue;
        const inputs = spec.inputs.map((k) =>
          (ev.metrics ?? []).find((m) => m.key === k)?.actual,
        );
        if (inputs.some((i) => !i || i.value == null)) continue;
        // Currency-consistency check: ratios (margins) are unit-free but
        // any sum/difference requires all inputs to share a unit — an
        // Enbridge-CAD + Yahoo-USD mix would produce garbage.
        if (spec.key === "fcf_usd_m" || spec.key === "total_debt_usd_m" || spec.key === "net_debt_usd_m") {
          const units = new Set(inputs.map((i) => i.unit));
          if (units.size > 1) continue;
        }
        const val = spec.compute(...inputs.map((i) => i.value));
        if (val == null || !Number.isFinite(val)) continue;
        if (!Array.isArray(ev.metrics)) ev.metrics = [];
        const primaryInput = inputs[0];
        ev.metrics.push({
          key: spec.key,
          displayLabel: spec.displayLabel,
          isHeadline: false,
          surprisePct: null,
          estimate: null,
          actual: {
            value: val,
            unit: spec.unitFrom(primaryInput, inputs[1]),
            source: {
              url: primaryInput.source?.url ?? "",
              label: `Derived from ${spec.inputs.join(" + ")}`,
              provenance: "regulatory",
              locator: null,
            },
            asOf: primaryInput.asOf ?? ev.eventDate ?? null,
            fetchedAt: now,
            method: "filing_manual",
            confidence: primaryInput.confidence ?? 0.9,
            // Non-standard field kept out of the Fact interface for
            // TypeScript-strict callers — reads via `unknown` in the UI.
            derived: true,
          },
          prior: null,
        });
        added++;
        shardDirty = true;
      }
    }
    if (shardDirty) touched++;
  }

  console.log(`\nShards touched:  ${touched}`);
  console.log(`Metrics added:   ${added}`);

  if (DRY) {
    console.log("Dry run — no writes.");
    return;
  }
  for (const [p, ctx] of shardBodies) {
    const body = ctx.wrapped ? { ...ctx.body, events: ctx.events } : ctx.events;
    await fs.writeFile(p, JSON.stringify(body, null, 2));
  }
  console.log(`✓ updated ${touched} shards`);
}

main().catch((e) => { console.error(e); process.exit(1); });
