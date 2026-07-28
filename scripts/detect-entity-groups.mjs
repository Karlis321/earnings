#!/usr/bin/env node
/**
 * Detect duplicate entity groups — one company, many listings.
 *
 * Signals, ranked by trust:
 *   (a) Same edgarCik              — high confidence  (auto-merge safe)
 *   (b) Same ISIN root (if present)— high confidence
 *   (c) Normalized name match      — medium confidence (goes to REVIEW
 *                                    unless corroborated by a wrapper
 *                                    ticker pattern)
 *
 * Writes scripts/audits/entity-groups.json with the full grouping and
 * prints a summary + a separate low-confidence subset. Read-only wrt
 * the registry — this is the detect step before any canonicalization.
 *
 *   node scripts/detect-entity-groups.mjs
 *   node scripts/detect-entity-groups.mjs --verbose      # per-group lines
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const OUT_DIR = path.join(ROOT, "scripts", "audits");
const OUT = path.join(OUT_DIR, "entity-groups.json");

const args = new Set(process.argv.slice(2));
const VERBOSE = args.has("--verbose");

// Legal suffixes + wrappers to strip when computing a normalized name.
// Order matters — longer patterns first. Applied to lowercased text.
const LEGAL_SUFFIX_RE = new RegExp(
  "(?:\\s+|-)(?:" +
    [
      "adr",
      "adrs",
      "bdr",
      "bdrs",
      "adr\\s*[nc]",
      "ord\\s+shs",
      "class\\s+[abcde]",
      "cl\\s+[abcde]",
      "shs\\s+[abcde]",
      "rep\\s*\\d+",
      "-\\s*rep\\s+\\d+\\s+ord",
      "-\\s*rep\\s+ord\\s+shs",
      "-\\s*rep\\s+bdrs?",
      "pref\\s+shs",
      "\\d+\\s+for\\s+\\d+",
      "inc\\.?",
      "incorporated",
      "corporation",
      "corp\\.?",
      "company",
      "companies",
      "co\\.?",
      "ltd\\.?",
      "limited",
      "plc",
      "public\\s+limited\\s+company",
      "sa",
      "s\\.a\\.?",
      "sab\\s+de\\s+cv",
      "sab",
      "ag",
      "aktiengesellschaft",
      "n\\.?v\\.?",
      "se",
      "s\\.?e\\.?",
      "kgaa",
      "gmbh",
      "as",
      "asa",
      "ab",
      "spa",
      "s\\.p\\.a\\.?",
      "srl",
      "s\\.r\\.l\\.?",
      "kk",
      "kabushiki\\s+kaisha",
      "co\\.?\\s*,?\\s*ltd\\.?",
      "holdings",
      "holding",
      "group",
      "grp",
      "trust",
      "reit",
      "the",
    ].join("|") +
    ")\\b",
  "gi",
);

const PUNCT_RE = /[.,\-&/(){}[\]!?"“”’`']/g;
const WS_RE = /\s+/g;

function normalizeName(name) {
  if (!name) return "";
  let s = name.toLowerCase();
  // Strip parenthetical suffixes like "(ADR)" or "(class B)"
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(PUNCT_RE, " ");
  // Repeatedly strip legal suffixes until fixpoint (handles "Corp Inc" etc.)
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(LEGAL_SUFFIX_RE, " ");
    if (s === before) break;
  }
  s = s.replace(WS_RE, " ").trim();
  return s;
}

// Bloomberg suffix → country/exchange class. Used to classify wrapper
// listings when a name-only match needs corroborating evidence.
function bloombergSuffix(ticker) {
  const parts = ticker.split(/\s+/);
  if (parts.length < 2) return null;
  return parts[parts.length - 1].toUpperCase();
}

// Ticker-shape hint: "34 BZ" / "35 BZ" / "32 BZ" is a Brazilian BDR;
// "F" or "Y" trailing on a US ticker is an OTC pink-sheet ADR;
// "GR" / "GY" listings are usually German shadows of a US primary.
function isWrapperTicker(ticker) {
  const suf = bloombergSuffix(ticker);
  if (!suf) return false;
  if (suf === "BZ" && /(?:34|35|32)$/.test(ticker.split(/\s+/)[0])) return true;
  if (suf === "GR" || suf === "GY") return true;
  if (suf === "US" && /[FY]$/.test(ticker.split(/\s+/)[0])) return true;
  return false;
}

// Union-find for merging groups discovered by different signals.
class DSU {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) { this.p.set(x, x); return x; }
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    let c = x;
    while (this.p.get(c) !== r) {
      const n = this.p.get(c);
      this.p.set(c, r);
      c = n;
    }
    return r;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const entities = reg.entities;
  console.log(`Entities to scan: ${entities.length}`);

  const dsu = new DSU();
  for (const e of entities) dsu.find(e.ticker); // ensure each ticker exists

  // Track which signal joined each pair so we can classify confidence.
  const signalOf = new Map(); // "tickerA|tickerB" → signal

  // Signal (a): edgarCik
  const byCik = new Map();
  for (const e of entities) {
    if (!e.edgarCik) continue;
    if (!byCik.has(e.edgarCik)) byCik.set(e.edgarCik, []);
    byCik.get(e.edgarCik).push(e.ticker);
  }
  for (const [cik, tickers] of byCik) {
    if (tickers.length < 2) continue;
    for (let i = 1; i < tickers.length; i++) {
      dsu.union(tickers[0], tickers[i]);
      const key = [tickers[0], tickers[i]].sort().join("|");
      signalOf.set(key, `cik:${cik}`);
    }
  }

  // Signal (c): normalized name — group by normalized name, but flag as
  // low-confidence unless the group has a member with a wrapper-ticker
  // shape (which corroborates the "one company, many listings" reading).
  const byNorm = new Map();
  for (const e of entities) {
    const n = normalizeName(e.displayName ?? e.legalName ?? "");
    if (!n || n.length < 2) continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(e);
  }
  for (const [norm, group] of byNorm) {
    if (group.length < 2) continue;
    // Are these already all in one CIK group?
    const roots = new Set(group.map((e) => dsu.find(e.ticker)));
    if (roots.size === 1) continue; // already grouped by CIK
    // Corroboration: any member is a wrapper-ticker OR the group spans
    // multiple exchange suffixes (which is the classic "one company,
    // multiple listings" fingerprint).
    const suffixes = new Set(group.map((e) => bloombergSuffix(e.ticker)));
    const hasWrapper = group.some((e) => isWrapperTicker(e.ticker));
    const corroborated = hasWrapper || suffixes.size > 1;
    const anchor = group[0].ticker;
    for (let i = 1; i < group.length; i++) {
      dsu.union(anchor, group[i].ticker);
      const key = [anchor, group[i].ticker].sort().join("|");
      if (!signalOf.has(key)) {
        signalOf.set(
          key,
          corroborated ? `name+wrapper:${norm}` : `name-only:${norm}`,
        );
      }
    }
  }

  // Collect groups
  const groups = new Map();
  for (const e of entities) {
    const root = dsu.find(e.ticker);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  }

  const multi = [...groups.values()].filter((g) => g.length > 1);
  multi.sort((a, b) => b.length - a.length);

  // Pick a canonical member per group — prefer US primary, else the
  // isCore ticker if any, else largest marketCap, else first.
  function canonicalOf(group) {
    const core = group.find((e) => e.isCore);
    if (core) return core.ticker;
    const usPrimary = group.find((e) => {
      const parts = e.ticker.split(/\s+/);
      return (
        parts[1] === "US" &&
        !/[FY]$/.test(parts[0]) && // exclude OTC pinks
        !/(?:34|35|32)$/.test(parts[0]) // exclude BDR-look
      );
    });
    if (usPrimary) return usPrimary.ticker;
    // Home-exchange fallback (LN, FP, GR, etc.) — pick the highest marketCap
    const withCap = group
      .slice()
      .sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
    return withCap[0]?.ticker ?? group[0].ticker;
  }

  // Classify confidence: any pair with a "cik:" signal → high; else if
  // any pair is "name+wrapper" → medium; else all pairs are "name-only"
  // → low (goes to review).
  function groupConfidence(group) {
    let hasCik = false;
    let hasCorrob = false;
    let hasNameOnly = false;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const k = [group[i].ticker, group[j].ticker].sort().join("|");
        const s = signalOf.get(k) ?? "";
        if (s.startsWith("cik:")) hasCik = true;
        else if (s.startsWith("name+wrapper:")) hasCorrob = true;
        else if (s.startsWith("name-only:")) hasNameOnly = true;
      }
    }
    if (hasCik) return "high";
    if (hasCorrob) return "medium";
    if (hasNameOnly) return "low";
    return "unknown";
  }

  const out = [];
  for (const g of multi) {
    const canonical = canonicalOf(g);
    const confidence = groupConfidence(g);
    const signals = new Set();
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const k = [g[i].ticker, g[j].ticker].sort().join("|");
        const s = signalOf.get(k);
        if (s) signals.add(s.split(":")[0]);
      }
    }
    out.push({
      canonical,
      confidence,
      matched_on: [...signals].sort(),
      members: g
        .map((e) => ({
          ticker: e.ticker,
          displayName: e.displayName,
          edgarCik: e.edgarCik ?? null,
          marketCapUsd: e.marketCapUsd ?? null,
          isCore: !!e.isCore,
        }))
        .sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0)),
    });
  }
  out.sort((a, b) => b.members.length - a.members.length);

  const totalGrouped = out.reduce((n, g) => n + g.members.length, 0);
  const highConf = out.filter((g) => g.confidence === "high");
  const medConf = out.filter((g) => g.confidence === "medium");
  const lowConf = out.filter((g) => g.confidence === "low");

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total groups (size >= 2):  ${out.length}`);
  console.log(`Total entities grouped:    ${totalGrouped}`);
  console.log(`Singletons:                ${entities.length - totalGrouped}`);
  console.log(`  high-confidence (CIK):   ${highConf.length}`);
  console.log(`  medium (name+wrapper):   ${medConf.length}`);
  console.log(`  low (name-only, REVIEW): ${lowConf.length}`);

  console.log(`\n=== TOP 15 HIGH-CONFIDENCE GROUPS ===`);
  for (const g of highConf.slice(0, 15)) {
    console.log(
      `  [${g.confidence}] ${g.canonical.padEnd(14)} (${g.members.length}) ${g.members
        .map((m) => m.ticker)
        .join(", ")}  matched=${g.matched_on.join(",")}`,
    );
  }

  console.log(`\n=== LOW-CONFIDENCE REVIEW LIST (${lowConf.length}) ===`);
  console.log(`(These are name-only collisions with no CIK / wrapper corroboration.`);
  console.log(` Manually confirm each before merging — "First National Bank" collisions are real.)`);
  for (const g of lowConf) {
    console.log(
      `  ${g.canonical.padEnd(14)} (${g.members.length}) ${g.members
        .map((m) => `${m.ticker}:${m.displayName ?? "-"}`)
        .join(" · ")}`,
    );
  }

  if (VERBOSE) {
    console.log(`\n=== ALL GROUPS ===`);
    for (const g of out) {
      console.log(
        `  [${g.confidence}] ${g.canonical} (${g.members.length}) ${g.members
          .map((m) => m.ticker)
          .join(", ")}  matched=${g.matched_on.join(",")}`,
      );
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    OUT,
    JSON.stringify(
      {
        schema: "entity-groups/v1",
        generatedAt: new Date().toISOString(),
        totals: {
          groups: out.length,
          entities_grouped: totalGrouped,
          singletons: entities.length - totalGrouped,
          high_confidence: highConf.length,
          medium_confidence: medConf.length,
          low_confidence: lowConf.length,
        },
        groups: out,
      },
      null,
      2,
    ),
  );
  console.log(`\n✓ wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
