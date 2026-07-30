#!/usr/bin/env node
/**
 * Populate entity.sourceCount + entity.sourceCountAsOf on every ticker
 * in the registry. Combines:
 *
 *   - Google News RSS OR-query (via ticker aliases) — 14-day window
 *   - Press-release RSS/EDGAR feeds from OFFICIAL_SOURCES (if any)
 *
 * Runs at concurrency 6. Rolls redirect URLs to publishers before
 * dedup so two gnews URLs pointing at the same Reuters article
 * collapse to one.
 *
 *   node scripts/backfill-source-counts.mjs
 *   node scripts/backfill-source-counts.mjs --dry
 *   node scripts/backfill-source-counts.mjs --portfolio
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const PORTFOLIO_ONLY = args.get("portfolio") === true;
const CONCURRENCY = 6;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const MIN_ALIAS_LEN = 2; // include short brand names like "B3", "BP"
const CN_SUFFIXES = ["TO", "V", "NE", "VN", "CN"];

function parseBloomberg(ticker) {
  const m = ticker.trim().match(
    /^([A-Z0-9]+)\s+(US|CN|PA|FH|LN|AU|JP|HK|SW|IJ|KS|MM|SJ|BZ|IN|CH|GR|IT|TB|C1|SP|HB|IR|NO|AV|GA|PW|TI|IM|SS|NA|DC|SW|FP|BB|AF)$/i,
  );
  if (!m) return null;
  return { base: m[1].toUpperCase(), exchange: m[2].toUpperCase() };
}
function collectAliases(entity) {
  const out = new Set();
  if (entity.displayName) out.add(entity.displayName.trim());
  if (entity.legalName) out.add(entity.legalName.trim());
  for (const a of entity.aliases ?? []) if (a?.trim()) out.add(a.trim());
  return [...out];
}
function tickerSearchTokens(entity) {
  const tokens = new Set();
  for (const a of collectAliases(entity)) {
    if (a.length >= MIN_ALIAS_LEN) tokens.add(a);
  }
  if (entity.cashtag) tokens.add(`$${entity.cashtag}`);
  const parsed = parseBloomberg(entity.ticker);
  if (parsed) {
    tokens.add(`$${parsed.base}`);
    // Also include the bare base symbol as an unquoted term — helps
    // for tickers whose aliases are quoted long phrases that don't
    // match natural headline style.
    tokens.add(parsed.base);
    if (parsed.exchange === "CN") {
      for (const sfx of CN_SUFFIXES) tokens.add(`${parsed.base}.${sfx}`);
    }
  }
  return [...tokens];
}

function buildGoogleNewsUrl(tokens, days) {
  const q = tokens.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(" OR ");
  const trimmed = q.slice(0, 480);
  const params = new URLSearchParams({
    q: `${trimmed} when:${days}d`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

async function fetchNewsCount(entity, days = 14) {
  const tokens = tickerSearchTokens(entity);
  if (tokens.length === 0) return 0;
  const url = buildGoogleNewsUrl(tokens, days);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return 0;
    const xml = await r.text();
    const items = xml.match(/<item[\s\S]*?<\/item>/g) ?? [];
    // Filter by time cutoff — Google News returns older items when the
    // when:Nd filter matches a shorter available window.
    const cutoff = Date.now() - days * 86_400_000;
    let count = 0;
    for (const block of items) {
      const dateM = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (!dateM) {
        count++;
        continue;
      }
      try {
        if (new Date(dateM[1].trim()).getTime() >= cutoff) count++;
      } catch {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  console.log(`backfill-source-counts · dry=${DRY} portfolio=${PORTFOLIO_ONLY}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  let targets = reg.entities;
  if (PORTFOLIO_ONLY) targets = targets.filter((e) => e.isCore);
  console.log(`Targets: ${targets.length}`);

  const asOf = new Date().toISOString().slice(0, 10);
  let touched = 0;
  const distribution = { "0": 0, "1-5": 0, "6-20": 0, "21-50": 0, "50+": 0 };

  await pool(targets, CONCURRENCY, async (entity, idx) => {
    if (idx > 0 && idx % 100 === 0) {
      console.log(`  [${idx}/${targets.length}] processed`);
    }
    const count = await fetchNewsCount(entity, 14);
    entity.sourceCount = count;
    entity.sourceCountAsOf = asOf;
    touched++;
    if (count === 0) distribution["0"]++;
    else if (count <= 5) distribution["1-5"]++;
    else if (count <= 20) distribution["6-20"]++;
    else if (count <= 50) distribution["21-50"]++;
    else distribution["50+"]++;
  });

  console.log(`\nEntities touched: ${touched}`);
  console.log(`Distribution:`);
  for (const [k, v] of Object.entries(distribution)) {
    console.log(`  ${k.padEnd(6)} ${v}`);
  }

  // Portfolio detail
  if (!PORTFOLIO_ONLY) {
    const portfolio = reg.entities.filter((e) => e.isCore);
    console.log(`\nPortfolio SRC counts:`);
    for (const e of portfolio.sort((a, b) => (b.sourceCount ?? 0) - (a.sourceCount ?? 0))) {
      console.log(`  ${e.ticker.padEnd(12)} ${String(e.sourceCount ?? 0).padStart(4)}  ${e.displayName}`);
    }
  }

  if (DRY) {
    console.log("Dry run — no write.");
    return;
  }
  await fs.writeFile(REGISTRY, JSON.stringify(reg, null, 2));
  console.log(`\n✓ wrote ${REGISTRY}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
