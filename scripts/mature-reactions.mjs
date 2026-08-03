#!/usr/bin/env node
/**
 * Standalone reaction maturation. Mirrors
 * frontend/server/lib/reactionMaturation.ts but runs outside the
 * Next.js env so we can mature the universe without paying the
 * 300s Vercel function budget.
 *
 * For every event with pending reaction points (absReturn=null,
 * populatesOn<=today) OR missing baseline while eventDate has passed:
 *   1. Pull Yahoo v8 chart bars for the security's yahooSymbol (3mo)
 *   2. Seed baseline: BMO → event day close, AMC → next session
 *   3. For each pending horizon:
 *       d1 = 1 session after baseline
 *       d3 = 3 sessions
 *       w1 = 5 sessions
 *       m1 = 21 sessions
 *      compute absReturn = (close - baselineClose) / baselineClose
 *   4. Pull benchmark bars; compute excessReturn = absReturn - benchmarkAbs
 *   5. If horizon extends past last bar → clip to last bar, status=clipped
 *   6. If event > 90d old and no bars → mark unavailable
 *
 *   node scripts/mature-reactions.mjs [--dry] [--limit=N]
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

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? Number(args.get("limit")) : Infinity;
const ONLY = args.get("only")
  ? new Set(String(args.get("only")).split(",").map((t) => t.trim()))
  : null;
const SP500_ONLY = args.get("sp500-only") === true;

// Yahoo v8 chart endpoint rejects short UA strings from datacenter
// IPs (301/656 events errored in the 2026-08-03 GH Actions run,
// leaving XOM/ABBV/CVX/etc. reactions pending despite fresh event
// dates). Use a full browser UA + Accept-Language header.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 15_000;

const OFFSETS = { d1: 1, d3: 3, w1: 5, m1: 21 };

const BENCHMARK_MAP = {
  SOX: "^SOX", SPX: "^GSPC", NDX: "^NDX", RUT: "^RUT",
  DAX: "^GDAXI", FTSE: "^FTSE", N225: "^N225",
  BOVESPA: "^BVSP", IBOV: "^BVSP", TSX: "^GSPTSE",
  "HG=F": "HG=F", "GC=F": "GC=F", "SI=F": "SI=F", "CL=F": "CL=F",
  URA: "URA", XLE: "XLE", XLK: "XLK",
  MEXBOL: "^MXX", MERVAL: "^MERV",
  SENSEX: "^BSESN", NIFTY: "^NSEI",
  HSI: "^HSI", KOSPI: "^KS11", TWII: "^TWII", STI: "^STI",
};

const barsCache = new Map();

async function yahooBars(symbol) {
  if (barsCache.has(symbol)) return barsCache.get(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  // 2-attempt retry — Yahoo v8 chart intermittently returns 429/5xx
  // from datacenter IPs. Real browsers get a full UA + Accept-Language.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!r.ok) {
        if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        barsCache.set(symbol, []);
        return [];
      }
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result) { barsCache.set(symbol, []); return []; }
    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      const c = closes[i];
      if (t == null || c == null) continue;
      const d = new Date(t * 1000);
      bars.push({
        date: d.toISOString().slice(0, 10),
        close: c,
      });
    }
    barsCache.set(symbol, bars);
    return bars;
    } catch {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      barsCache.set(symbol, []);
      return [];
    }
  }
  barsCache.set(symbol, []);
  return [];
}

function pickBaselineIdx(bars, anchorDate, timing) {
  const anchorTs = new Date(anchorDate).getTime();
  if (timing === "AMC") {
    return bars.findIndex((b) => new Date(b.date).getTime() > anchorTs);
  }
  return bars.findIndex((b) => new Date(b.date).getTime() >= anchorTs);
}

function findBaselineIndex(bars, baselineDate) {
  const exact = bars.findIndex((b) => b.date === baselineDate);
  if (exact >= 0) return exact;
  const target = new Date(baselineDate).getTime();
  return bars.findIndex((b) => new Date(b.date).getTime() >= target);
}

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`mature-reactions · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT} concurrency=${CONCURRENCY}`);
  const now = new Date();
  const nowIso = now.toISOString();

  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const byTicker = new Map();
  for (const e of reg.entities ?? []) byTicker.set(e.ticker, e);

  // Collect (ticker, shardPath, events) whose events need maturation.
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));
  const targets = [];
  for (const f of files) {
    const shardPath = path.join(EVENTS_DIR, f);
    let shard;
    try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); } catch { continue; }
    const wrapped = !Array.isArray(shard);
    const events = wrapped ? shard.events ?? [] : shard;
    // Filter by ticker or SP500 membership if requested. Peek at the
    // first event's ticker (all events in a shard share it).
    const t = events[0]?.ticker;
    if (t) {
      if (ONLY && !ONLY.has(t)) continue;
      if (SP500_ONLY) {
        const ent = byTicker.get(t);
        if (!ent || !(ent.index_membership ?? []).includes("SP500")) continue;
      }
    }
    const toMature = [];
    for (const e of events) {
      if (!e.eventDate) continue;
      const hasBaseline = e.reaction?.baselineDate && e.reaction?.baselineClose != null;
      const points = e.reaction?.points ?? [];
      const readyPending = points.filter(
        (p) => p.absReturn == null && (!p.populatesOn || new Date(p.populatesOn) <= now),
      );
      const needsBootstrap = points.length === 0 && new Date(e.eventDate) <= now;
      if (readyPending.length > 0 || (!hasBaseline && new Date(e.eventDate) <= now) || needsBootstrap) {
        toMature.push(e);
      }
    }
    if (toMature.length === 0) continue;
    const ticker = events[0]?.ticker ?? f.replace(/\.json$/, "").replace(/_/g, " ");
    const entity = byTicker.get(ticker);
    if (!entity?.yahooSymbol) continue;
    targets.push({ shardPath, shard, wrapped, events, toMature, entity });
  }
  const capped = targets.slice(0, LIMIT);
  console.log(`Targets: ${capped.length} shards with maturable events (of ${targets.length} eligible)`);

  const rollup = {
    schema: "mature-reactions/v1",
    generatedAt: nowIso,
    totals: {
      shardsProcessed: 0,
      shardsWritten: 0,
      eventsProcessed: 0,
      pointsMatured: 0,
      pointsClipped: 0,
      pointsUnavailable: 0,
      baselinesSeeded: 0,
      errors: 0,
    },
  };

  let processed = 0;
  await pool(capped, CONCURRENCY, async (t) => {
    processed++;
    rollup.totals.shardsProcessed++;
    const secBars = await yahooBars(t.entity.yahooSymbol);
    const benchStr = t.entity.benchmark ?? "";
    const benchSym = BENCHMARK_MAP[benchStr] ?? (benchStr || null);
    const benchBars = benchSym ? await yahooBars(benchSym) : [];

    let mutated = false;
    for (const e of t.toMature) {
      rollup.totals.eventsProcessed++;
      const anchor = e.eventDate ?? e.scheduledDate;

      if (secBars.length === 0) {
        // Decay old events to unavailable.
        const ageDays = (now - new Date(anchor)) / 86_400_000;
        if (ageDays > 90) {
          e.reaction.points = e.reaction.points.map((p) => {
            if (p.absReturn != null) return p;
            rollup.totals.pointsUnavailable++;
            return { ...p, status: "unavailable", computedAt: nowIso };
          });
          mutated = true;
        }
        rollup.totals.errors++;
        continue;
      }

      // Seed baseline if missing.
      let baselineDate = e.reaction?.baselineDate ?? null;
      let baselineClose = e.reaction?.baselineClose ?? null;
      if (!baselineDate || baselineClose == null) {
        const idx = pickBaselineIdx(secBars, anchor, e.timing);
        if (idx >= 0) {
          baselineDate = secBars[idx].date;
          baselineClose = secBars[idx].close;
          rollup.totals.baselinesSeeded++;
        }
      }
      if (!baselineDate || baselineClose == null) continue;

      const secBaseIdx = findBaselineIndex(secBars, baselineDate);
      if (secBaseIdx < 0) continue;
      const benchBaseIdx = benchBars.length > 0 ? findBaselineIndex(benchBars, baselineDate) : -1;

      // Seed the horizons array if empty — refresh-yahoo-shards
      // creates events with `reaction: null` or empty points, and
      // mature-reactions must be the one to bootstrap the array
      // (otherwise these events stay uninstrumented forever).
      if (!e.reaction) e.reaction = { benchmark: t.entity.benchmark ?? "", baselineDate, baselineClose, points: [] };
      if (!Array.isArray(e.reaction.points) || e.reaction.points.length === 0) {
        e.reaction.points = ["d1", "d3", "w1", "m1"].map((horizon) => ({
          horizon,
          absReturn: null,
          excessReturn: null,
          benchmark: t.entity.benchmark ?? "",
          computedAt: null,
          populatesOn: null,
          status: "pending",
        }));
      }
      const nextPoints = e.reaction.points.map((p) => {
        if (p.absReturn != null) return p;
        if (p.populatesOn && new Date(p.populatesOn) > now) return p;
        const offset = OFFSETS[p.horizon];
        if (offset == null) return p;
        let secIdx = secBaseIdx + offset;
        let clipped = false;
        if (secIdx >= secBars.length) {
          const lastIdx = secBars.length - 1;
          if (lastIdx > secBaseIdx) { secIdx = lastIdx; clipped = true; }
          else return p;
        }
        const absReturn = (secBars[secIdx].close - baselineClose) / baselineClose;
        let excessReturn = null;
        let gapFlagged = false;
        if (benchBaseIdx >= 0) {
          let bIdx = benchBaseIdx + offset;
          if (bIdx >= benchBars.length) {
            if (benchBars.length - 1 > benchBaseIdx) bIdx = benchBars.length - 1;
            else bIdx = -1;
          }
          if (bIdx >= 0) {
            const benchBase = benchBars[benchBaseIdx].close;
            const benchAbs = (benchBars[bIdx].close - benchBase) / benchBase;
            excessReturn = absReturn - benchAbs;
          } else gapFlagged = true;
        } else gapFlagged = true;

        if (clipped) rollup.totals.pointsClipped++;
        else rollup.totals.pointsMatured++;

        return {
          ...p,
          absReturn,
          excessReturn,
          computedAt: nowIso,
          gapFlagged: gapFlagged || undefined,
          clipped: clipped || undefined,
          status: clipped ? "clipped" : "matured",
        };
      });

      e.reaction = {
        ...(e.reaction ?? {}),
        benchmark: t.entity.benchmark ?? e.reaction?.benchmark ?? "",
        baselineDate,
        baselineClose,
        points: nextPoints,
      };
      mutated = true;
    }

    if (mutated && !DRY) {
      const body = t.wrapped ? { ...t.shard, events: t.events } : t.events;
      fssync.writeFileSync(t.shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
    }

    if (processed % 50 === 0 || processed === capped.length) {
      console.log(`  ${processed}/${capped.length} · matured=${rollup.totals.pointsMatured} clipped=${rollup.totals.pointsClipped} unavailable=${rollup.totals.pointsUnavailable} · shards=${rollup.totals.shardsWritten}`);
    }
  });

  console.log(`\n=== mature-reactions ===`);
  console.log(`Shards processed:     ${rollup.totals.shardsProcessed}`);
  console.log(`Shards written:       ${rollup.totals.shardsWritten}`);
  console.log(`Events processed:     ${rollup.totals.eventsProcessed}`);
  console.log(`Baselines seeded:     ${rollup.totals.baselinesSeeded}`);
  console.log(`Points matured:       ${rollup.totals.pointsMatured}`);
  console.log(`Points clipped:       ${rollup.totals.pointsClipped}`);
  console.log(`Points unavailable:   ${rollup.totals.pointsUnavailable}`);
  console.log(`Errors:               ${rollup.totals.errors}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "mature-reactions.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/mature-reactions.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
