#!/usr/bin/env node
/**
 * Backfill `industryGroup` on every entity from Yahoo's v7/quote
 * industry field (assetProfile-granularity — Semiconductors, Software
 * & Services, Metals & Mining, Banks-Diversified, Oil & Gas E&P, …).
 *
 * Reads registry, batches yahoo symbols in groups of 100, extracts
 * industry per symbol, writes it back to the entity as
 * industryGroup + industryGroupAsOf.
 *
 *   node scripts/backfill-industry-groups.mjs             # write
 *   node scripts/backfill-industry-groups.mjs --dry       # report only
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");

// v10 quoteSummary with modules=assetProfile is the canonical source
// for GICS-industry-group-granularity `industry` labels. v7/quote used
// to include it but Yahoo dropped that field. Requires the crumb+cookie
// handshake — same pattern as frontend/server/vendors/yahoo.ts.
const CONCURRENCY = 8;

async function getCrumb() {
  const cookieRes = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": "Mozilla/5.0 (backfill-industry-groups)" },
    redirect: "follow",
  }).catch(() => null);
  const setCookie = cookieRes?.headers.get("set-cookie") ?? "";
  const cookie = setCookie
    .split(",")
    .map((s) => s.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
  const crumbRes = await fetch(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (backfill-industry-groups)",
        Cookie: cookie,
      },
    },
  );
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length > 24) return null;
  return { crumb, cookie };
}

async function fetchIndustry(symbol, state) {
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=assetProfile&crumb=${encodeURIComponent(state.crumb)}`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (backfill-industry-groups)",
        Cookie: state.cookie,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const ap = j?.quoteSummary?.result?.[0]?.assetProfile ?? null;
    if (!ap) return { empty: true };
    return { industry: ap.industry ?? null };
  } catch (e) {
    return { error: e.message ?? "network" };
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
  console.log(`backfill-industry-groups · dry=${DRY}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const symbols = reg.entities
    .map((e) => e.yahooSymbol)
    .filter((s) => typeof s === "string" && s.length > 0);
  console.log(`Symbols to probe: ${symbols.length} · concurrency ${CONCURRENCY}`);

  const state = await getCrumb();
  if (!state) {
    console.error("Failed to acquire Yahoo crumb — aborting.");
    process.exit(1);
  }
  console.log(`crumb=${state.crumb.slice(0, 6)}…`);

  const bySymbol = new Map();
  let errCount = 0;
  let emptyCount = 0;
  let processed = 0;
  await pool(symbols, CONCURRENCY, async (sym) => {
    const r = await fetchIndustry(sym, state);
    processed++;
    if (processed % 100 === 0) {
      console.log(
        `  [${processed}/${symbols.length}] · mapped ${bySymbol.size} · err ${errCount} · empty ${emptyCount}`,
      );
    }
    if (r.error) { errCount++; return; }
    if (r.empty) { emptyCount++; return; }
    if (r.industry) bySymbol.set(sym, r.industry);
  });

  const asOf = new Date().toISOString();
  let touched = 0;
  const oldSectorMapping = new Map(); // oldTopSector → Set<industryGroup>
  for (const entity of reg.entities) {
    if (!entity.yahooSymbol) continue;
    const ind = bySymbol.get(entity.yahooSymbol);
    if (!ind) continue;
    if (entity.industryGroup === ind) continue;
    entity.industryGroup = ind;
    entity.industryGroupAsOf = asOf;
    touched++;
    // Track mapping using the entity's first sector tag as the "old"
    // dimension so the report can show old→new.
    const oldTag = (entity.sectorTags ?? [])[0] ?? "(untagged)";
    if (!oldSectorMapping.has(oldTag)) oldSectorMapping.set(oldTag, new Set());
    oldSectorMapping.get(oldTag).add(ind);
  }

  console.log(`\nEntities touched:      ${touched}`);
  console.log(`Symbols errored:       ${errCount}`);
  console.log(`Symbols empty profile: ${emptyCount}`);
  console.log(`Distinct industries:   ${new Set(bySymbol.values()).size}`);

  // Distribution
  const indDist = new Map();
  for (const e of reg.entities) {
    const k = e.industryGroup ?? "(none)";
    indDist.set(k, (indDist.get(k) ?? 0) + 1);
  }
  console.log("\nTop 20 industry groups by count:");
  const topInd = [...indDist].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [k, n] of topInd) console.log("  " + k.padEnd(48) + n);

  // Per-cap-band × industry-group
  console.log("\nCap-band × industry-group counts (top 5 industries per band):");
  const byBand = new Map();
  for (const e of reg.entities) {
    const band = e.capTier ?? "unknown";
    if (!byBand.has(band)) byBand.set(band, new Map());
    const m = byBand.get(band);
    const k = e.industryGroup ?? "(none)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  for (const band of ["mega", "large", "mid", "small", "unknown"]) {
    const m = byBand.get(band);
    if (!m) continue;
    const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(
      `  ${band.padEnd(8)} → ${top
        .map(([k, n]) => `${k}:${n}`)
        .join(" · ")}`,
    );
  }

  console.log("\nOld top-sector → industry groups (first 10):");
  const mapEntries = [...oldSectorMapping].slice(0, 10);
  for (const [oldTag, indSet] of mapEntries) {
    console.log(
      `  ${oldTag.padEnd(20)} → ${[...indSet].slice(0, 6).join(", ")}${
        indSet.size > 6 ? ` … (+${indSet.size - 6})` : ""
      }`,
    );
  }

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
