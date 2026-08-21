#!/usr/bin/env node
/**
 * Sector-level rollup for the /themes view. Aggregates per-sector
 * metrics from events-index + registry, then reads shards ONLY for
 * the top movers per sector to pull recent headlines. Deterministic,
 * no LLM, no vendor calls. Writes data/sector-signals.json.
 *
 *   node scripts/aggregate-by-sector.mjs [--dry] [--news-window-days N] [--top-per-sector N]
 *
 * Notes:
 *  · A ticker with multiple sectorTags contributes to EACH sector
 *    it carries — an HBM US shows up under copper, materials, mining.
 *    That mirrors how a theme actually forms (a stock can belong to
 *    multiple threads).
 *  · Structural tags (etf, developer) and geography tags (canada,
 *    brazil) are excluded from sector keys — those aren't themes.
 *  · Sectors with < 3 tickers are dropped as too thin to signal.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const INDEX_PATH = path.join(ROOT, "data", "events-index.json");
const SHARDS_DIR = path.join(ROOT, "data", "events");
const OUT_PATH = path.join(ROOT, "data", "sector-signals.json");

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry");
const NEWS_WINDOW_DAYS = Number(
  ARGS.find((a) => a.startsWith("--news-window-days="))?.split("=")[1] ?? 14,
);
const TOP_PER_SECTOR = Number(
  ARGS.find((a) => a.startsWith("--top-per-sector="))?.split("=")[1] ?? 5,
);
const MIN_TICKERS_PER_SECTOR = 3;

// Tags that describe wrapper / geography, not a real theme.
const STRUCTURAL_TAGS = new Set([
  "etf",
  "developer",
  "canada",
  "brazil",
  "emerging-markets",
]);

// Slug -> "TICKER_EX.json" — mirror shard-earnings.mjs.
function shardFilename(ticker) {
  return ticker.replace(/ /g, "_") + ".json";
}

function inUniverse(entity) {
  // Themes work at the entire-tracked-universe level — not the
  // SP500/R1000-only slice the ranking uses. A copper miner ETF
  // (GDXJ), a developer (WRN), and a foreign operator (CS CN) all
  // belong in the 'copper' theme even though they're excluded from
  // per-ticker composite ranking. We only require:
  //   · has a registry entry
  //   · not dormant
  //   · is displayable (excludes hidden entities like collapsed
  //     duplicates or pre-listing shells)
  if (!entity) return false;
  if (entity.dormant) return false;
  if (entity.securityType === "pre-listing") return false;
  return true;
}

function pickReactionRaw(entry) {
  const pts = entry?.lastEventReactionPoints ?? [];
  const d3 = pts.find((p) => p.horizon === "d3");
  if (!d3) return null;
  if (typeof d3.excessReturn === "number") return d3.excessReturn;
  if (typeof d3.absReturn === "number") return d3.absReturn;
  return null;
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function readShardHeadlines(ticker, cutoffIso) {
  try {
    const p = path.join(SHARDS_DIR, shardFilename(ticker));
    const raw = await fs.readFile(p, "utf-8");
    const shard = JSON.parse(raw);
    const events = Array.isArray(shard.events) ? shard.events : [];
    const headlines = [];
    for (const ev of events) {
      const items = ev?.sources?.items ?? [];
      for (const it of items) {
        const time = it.time ?? it.publishedAt ?? it.capturedAt;
        if (!time || time < cutoffIso) continue;
        headlines.push({
          ticker,
          headline: it.headline ?? "(untitled)",
          time,
          source: it.source?.label ?? it.provenance ?? "",
          url: it.url ?? null,
        });
      }
    }
    return headlines;
  } catch {
    return [];
  }
}

async function main() {
  const [regRaw, idxRaw] = await Promise.all([
    fs.readFile(REG_PATH, "utf-8"),
    fs.readFile(INDEX_PATH, "utf-8"),
  ]);
  const reg = JSON.parse(regRaw);
  const idx = JSON.parse(idxRaw);
  const entities = reg.entities ?? [];
  const byTicker = new Map(entities.map((e) => [e.ticker, e]));

  // Per-sector accumulator: sector → array of ticker rows
  const sectorRows = new Map();

  for (const entry of idx.entries ?? []) {
    const entity = byTicker.get(entry.ticker);
    if (!inUniverse(entity)) continue;
    const tags = Array.isArray(entity.sectorTags) ? entity.sectorTags : [];
    const reaction = pickReactionRaw(entry);
    const surprise =
      typeof entry.lastSurprisePct === "number" ? entry.lastSurprisePct : null;
    const sourceCount =
      typeof entry.sourceCount === "number" ? entry.sourceCount : 0;

    const row = {
      ticker: entry.ticker,
      displayName: entity.displayName,
      capTier: entity.capTier ?? "unknown",
      marketCapUsd: entity.marketCapUsd ?? null,
      lastEventDate: entry.lastEventDate ?? null,
      lastPeriod: entry.lastPeriod ?? null,
      reaction3d: reaction === null ? null : Number((reaction * 100).toFixed(2)),
      lastSurprisePct: surprise === null ? null : Number(surprise.toFixed(2)),
      sourceCount,
    };

    for (const tag of tags) {
      if (STRUCTURAL_TAGS.has(tag)) continue;
      if (!sectorRows.has(tag)) sectorRows.set(tag, []);
      sectorRows.get(tag).push(row);
    }
  }

  // Reduce per-sector; drop thin sectors
  const cutoffIso = new Date(Date.now() - NEWS_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const sectorsOut = [];
  const sortedEntries = [...sectorRows.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [tag, rows] of sortedEntries) {
    if (rows.length < MIN_TICKERS_PER_SECTOR) continue;

    // Rank tickers in this sector by |reaction3d| for headline reads
    const withReaction = rows.filter((r) => r.reaction3d !== null);
    withReaction.sort(
      (a, b) => Math.abs(b.reaction3d) - Math.abs(a.reaction3d),
    );
    const topMovers = withReaction.slice(0, TOP_PER_SECTOR);

    // Metrics
    const reactions = rows
      .map((r) => r.reaction3d)
      .filter((v) => typeof v === "number");
    const surprises = rows
      .map((r) => r.lastSurprisePct)
      .filter((v) => typeof v === "number");
    const totalSourceCount = rows.reduce((s, r) => s + (r.sourceCount ?? 0), 0);

    // Pull headlines only for top movers (bounded shard reads)
    const headlines = [];
    for (const mover of topMovers) {
      const list = await readShardHeadlines(mover.ticker, cutoffIso);
      headlines.push(...list);
    }
    // Sort headlines newest-first, keep the top 20 for the panel
    headlines.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
    const keptHeadlines = headlines.slice(0, 20);

    sectorsOut.push({
      sector: tag,
      tickerCount: rows.length,
      medianReaction3d: median(reactions),
      medianSurprise: median(surprises),
      newsCountAll: totalSourceCount,
      topMovers: topMovers.map((m) => ({
        ticker: m.ticker,
        displayName: m.displayName,
        reaction3d: m.reaction3d,
        lastSurprisePct: m.lastSurprisePct,
        lastEventDate: m.lastEventDate,
        lastPeriod: m.lastPeriod,
      })),
      recentHeadlines: keptHeadlines,
      tickers: rows.map((r) => r.ticker).sort(),
    });
  }

  // Sort sectors by |medianReaction3d| descending (strongest theme first)
  sectorsOut.sort((a, b) => {
    const av = a.medianReaction3d === null ? -Infinity : Math.abs(a.medianReaction3d);
    const bv = b.medianReaction3d === null ? -Infinity : Math.abs(b.medianReaction3d);
    return bv - av;
  });

  const out = {
    schema: "sector-signals/v1",
    generatedAt: new Date().toISOString(),
    newsWindowDays: NEWS_WINDOW_DAYS,
    minTickersPerSector: MIN_TICKERS_PER_SECTOR,
    sectors: sectorsOut,
  };

  console.log(
    `aggregate-by-sector · ${sectorsOut.length} sectors (dropped thin < ${MIN_TICKERS_PER_SECTOR}) · newsWindow=${NEWS_WINDOW_DAYS}d`,
  );
  const top = sectorsOut.slice(0, 8);
  for (const s of top) {
    console.log(
      `  · ${s.sector.padEnd(24)} · ${String(s.tickerCount).padStart(3)} tickers · med reaction ${(s.medianReaction3d ?? 0).toFixed(2)}% · news ${s.newsCountAll}`,
    );
  }

  if (DRY) {
    console.log("[dry] would write", OUT_PATH);
  } else {
    await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
    console.log(`✓ wrote data/sector-signals.json · ${sectorsOut.length} sectors`);
  }
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
