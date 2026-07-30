#!/usr/bin/env node
/**
 * Backfill reaction returns on events whose reaction points are still
 * pending or terminal-unavailable. Item 3b's probe confirmed Yahoo bars
 * exist for 100% of tickers with orphaned old events — so the 20,672
 * points marked "unavailable" (by apply-reaction-decay --include-stale)
 * are computable if we fetch a wide-enough bar range.
 *
 * Mirrors the arithmetic in `frontend/server/lib/reactionMaturation.ts`:
 *   - baseline = pickBaselineIdx(bars, anchor, timing)
 *   - d1/d3/w1/m1 = OFFSETS[horizon]
 *   - absReturn = (secClose - baseClose) / baseClose
 *   - excessReturn = absReturn - benchAbs (when benchmark bars align)
 *   - contamination = newer sibling inside [baseline, horizon-end]
 *   - clipping when the horizon extends past the last bar
 *
 * What's different: this script fetches `max`-range Yahoo bars (up to
 * ~10y) so historical events are covered, and processes hundreds of
 * tickers in a rate-limited batch with checkpointing to disk so an
 * interruption resumes on the next run.
 *
 *   node scripts/backfill-reactions.mjs           # write
 *   node scripts/backfill-reactions.mjs --dry     # report only
 *   node scripts/backfill-reactions.mjs --limit=50
 *
 * Reports per-exchange split: computed / kept-unavailable / kept-
 * pending, so the pipeline report's reactions_unavailable counter
 * drops to only true no-bars residuals.
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");
const CKPT_PATH = path.join(OUT_DIR, "backfill-reactions.checkpoint.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? parseInt(args.get("limit"), 10) : Infinity;
const YAHOO_MS = 700; // Yahoo tolerates ~1.5 req/s per host with a browser-y UA

const UA = "Mozilla/5.0 (backfill-reactions)";
const YAHOO_HEADERS = { "User-Agent": UA, Accept: "*/*" };

const OFFSETS = { d1: 1, d3: 3, w1: 5, m1: 21 };
const BENCHMARK_MAP = {
  SOX: "^SOX", SPX: "^GSPC", NDX: "^NDX", RUT: "^RUT",
  DAX: "^GDAXI", FTSE: "^FTSE", N225: "^N225",
  BOVESPA: "^BVSP", IBOV: "^BVSP", TSX: "^GSPTSE",
  "HG=F": "HG=F", "GC=F": "GC=F", "SI=F": "SI=F", "CL=F": "CL=F",
  URA: "URA", XLE: "XLE", XLK: "XLK",
};

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function exchangeOf(t) {
  const parts = t.split(/\s+/);
  return parts[parts.length - 1];
}

async function yahooBars(symbol, range = "max") {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=${range}`;
  try {
    const r = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result) return { bars: [] };
    const ts = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === "number") {
        bars.push({
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          close: c,
        });
      }
    }
    return { bars };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

function findBaselineIndex(bars, baselineDate) {
  const exact = bars.findIndex((b) => b.date === baselineDate);
  if (exact >= 0) return exact;
  const target = new Date(baselineDate).getTime();
  return bars.findIndex((b) => new Date(b.date).getTime() >= target);
}

function pickBaselineIdx(bars, anchorDate, timing) {
  const anchorTs = new Date(anchorDate).getTime();
  if (timing === "AMC") {
    return bars.findIndex((b) => new Date(b.date).getTime() > anchorTs);
  }
  return bars.findIndex((b) => new Date(b.date).getTime() >= anchorTs);
}

async function readCheckpoint() {
  try {
    const raw = await fs.readFile(CKPT_PATH, "utf-8");
    const j = JSON.parse(raw);
    return new Set(j.done ?? []);
  } catch {
    return new Set();
  }
}
async function writeCheckpoint(doneSet) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(CKPT_PATH, JSON.stringify({ done: [...doneSet] }, null, 2));
}

async function main() {
  console.log(`backfill-reactions · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entityByTicker = new Map((reg.entities ?? []).map((e) => [e.ticker, e]));
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));

  // Pass 1: find candidate events (any reaction point with absReturn===null,
  // regardless of status — this catches both "unavailable" and "pending"
  // so any bar-available ticker gets its old events computed).
  const candidatesByTicker = new Map();
  let totalCandidatePoints = 0;
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const raw = JSON.parse(await fs.readFile(p, "utf-8"));
    const evs = Array.isArray(raw) ? raw : raw.events ?? [];
    for (const ev of evs) {
      const anchor = ev.eventDate ?? ev.scheduledDate;
      if (!anchor) continue;
      const unresolved = (ev.reaction?.points ?? []).filter(
        (pt) => pt.absReturn === null || pt.absReturn === undefined,
      );
      if (unresolved.length === 0) continue;
      totalCandidatePoints += unresolved.length;
      const key = ev.ticker;
      if (!candidatesByTicker.has(key)) {
        candidatesByTicker.set(key, { shard: p, wrapped: !Array.isArray(raw), body: raw, events: evs, hits: [] });
      }
      candidatesByTicker.get(key).hits.push(ev);
    }
  }
  console.log(`Candidate tickers:      ${candidatesByTicker.size}`);
  console.log(`Candidate points total: ${totalCandidatePoints}`);

  const ckpt = await readCheckpoint();
  const tickers = [...candidatesByTicker.keys()].filter((t) => !ckpt.has(t)).slice(0, LIMIT);
  console.log(`Tickers to process (post-checkpoint, limit): ${tickers.length}`);

  const benchCache = new Map(); // benchSymbol → bars
  const audit = {
    schema: "backfill-reactions/v1",
    generatedAt: new Date().toISOString(),
    tickersProcessed: 0,
    pointsComputed: 0,
    pointsMarkedUnavailable: 0,
    pointsLeftPending: 0,
    perExchange: {},
    perTickerSample: [],
  };
  const nowIso = new Date().toISOString();
  const shardsWrote = new Set();

  for (const [i, ticker] of tickers.entries()) {
    const ent = entityByTicker.get(ticker);
    const ctx = candidatesByTicker.get(ticker);
    if (!ent?.yahooSymbol) {
      // No yahoo symbol → cannot fetch bars → keep as-is
      audit.perTickerSample.push({ ticker, status: "no-yahoo-symbol", pointCount: ctx.hits.reduce((a, b) => a + b.reaction.points.filter((p) => p.absReturn == null).length, 0) });
      ckpt.add(ticker);
      continue;
    }
    const exch = exchangeOf(ticker);
    if (!audit.perExchange[exch]) {
      audit.perExchange[exch] = { computed: 0, unavailable: 0, pending: 0 };
    }

    // Fetch security bars (max range).
    const secR = await yahooBars(ent.yahooSymbol, "max");
    await new Promise((r) => setTimeout(r, YAHOO_MS));
    if (secR.error || !secR.bars || secR.bars.length === 0) {
      // Genuinely no bars — flip everything unavailable.
      for (const ev of ctx.hits) {
        for (const pt of ev.reaction.points) {
          if (pt.absReturn != null) continue;
          if (pt.status !== "unavailable") {
            pt.status = "unavailable";
            pt.computedAt = nowIso;
          }
          audit.pointsMarkedUnavailable++;
          audit.perExchange[exch].unavailable++;
        }
      }
      shardsWrote.add(ctx.shard);
      audit.tickersProcessed++;
      ckpt.add(ticker);
      continue;
    }
    const secBars = secR.bars;

    // Fetch benchmark bars once per unique benchmark.
    // Use the first hit's benchmark (should be uniform per ticker).
    const bench = ctx.hits[0]?.reaction?.benchmark ?? ent.benchmark ?? null;
    let benchBars = [];
    if (bench) {
      const benchSym = BENCHMARK_MAP[bench] ?? bench;
      if (benchCache.has(benchSym)) {
        benchBars = benchCache.get(benchSym);
      } else {
        const bR = await yahooBars(benchSym, "max");
        await new Promise((r) => setTimeout(r, YAHOO_MS));
        benchBars = bR.bars ?? [];
        benchCache.set(benchSym, benchBars);
      }
    }

    // Process each event on this ticker.
    for (const ev of ctx.hits) {
      const anchor = ev.eventDate ?? ev.scheduledDate;
      if (!anchor) continue;
      // Baseline: prefer stored baselineDate; else pickBaselineIdx.
      let baselineDate = ev.reaction?.baselineDate ?? null;
      let baselineClose = ev.reaction?.baselineClose ?? null;
      if (!baselineDate || baselineClose == null) {
        const idx = pickBaselineIdx(secBars, anchor, ev.timing);
        if (idx < 0) {
          for (const pt of ev.reaction.points) {
            if (pt.absReturn != null) continue;
            pt.status = "unavailable";
            pt.computedAt = nowIso;
            audit.pointsMarkedUnavailable++;
            audit.perExchange[exch].unavailable++;
          }
          shardsWrote.add(ctx.shard);
          continue;
        }
        baselineDate = secBars[idx].date;
        baselineClose = secBars[idx].close;
        ev.reaction.baselineDate = baselineDate;
        ev.reaction.baselineClose = baselineClose;
      }
      const secBaseIdx = findBaselineIndex(secBars, baselineDate);
      if (secBaseIdx < 0 || !baselineClose) {
        for (const pt of ev.reaction.points) {
          if (pt.absReturn != null) continue;
          pt.status = "unavailable";
          pt.computedAt = nowIso;
          audit.pointsMarkedUnavailable++;
          audit.perExchange[exch].unavailable++;
        }
        shardsWrote.add(ctx.shard);
        continue;
      }
      const benchBaseIdx = bench && benchBars.length > 0 ? findBaselineIndex(benchBars, baselineDate) : -1;
      // Newer siblings for contamination check.
      const currentAnchorTs = new Date(anchor).getTime();
      const newerSiblings = ctx.events.filter((s) =>
        s.id !== ev.id && s.eventDate && new Date(s.eventDate).getTime() > currentAnchorTs,
      );

      for (const pt of ev.reaction.points) {
        if (pt.absReturn != null) continue;
        const offset = OFFSETS[pt.horizon];
        if (offset == null) continue;
        let secIdx = secBaseIdx + offset;
        let clipped = false;
        if (secIdx >= secBars.length) {
          const lastIdx = secBars.length - 1;
          if (lastIdx > secBaseIdx) {
            secIdx = lastIdx;
            clipped = true;
          } else {
            // Not enough bars past baseline — leave pending.
            audit.pointsLeftPending++;
            audit.perExchange[exch].pending++;
            continue;
          }
        }
        const secClose = secBars[secIdx].close;
        const absReturn = (secClose - baselineClose) / baselineClose;

        let excessReturn = null;
        let gapFlagged = false;
        if (benchBaseIdx >= 0 && benchBars[benchBaseIdx] != null) {
          let benchIdx = benchBaseIdx + offset;
          if (benchIdx >= benchBars.length) {
            if (benchBars.length - 1 > benchBaseIdx) benchIdx = benchBars.length - 1;
            else benchIdx = -1;
          }
          if (benchIdx >= 0) {
            const benchBase = benchBars[benchBaseIdx].close;
            const benchClose = benchBars[benchIdx].close;
            const benchAbs = (benchClose - benchBase) / benchBase;
            excessReturn = absReturn - benchAbs;
          } else gapFlagged = true;
        } else gapFlagged = true;

        // Contamination check.
        const horizonEndDate = secBars[secIdx].date;
        const baselineTs = new Date(baselineDate).getTime();
        const endTs = new Date(horizonEndDate).getTime();
        let contaminated = false;
        for (const sib of newerSiblings) {
          const sTs = new Date(sib.eventDate).getTime();
          if (sTs > baselineTs && sTs <= endTs) { contaminated = true; break; }
        }

        pt.absReturn = absReturn;
        pt.excessReturn = excessReturn;
        pt.computedAt = nowIso;
        pt.status = clipped ? "clipped" : "matured";
        if (gapFlagged) pt.gapFlagged = true;
        if (clipped) pt.clipped = true;
        if (contaminated) pt.contaminated = true;
        audit.pointsComputed++;
        audit.perExchange[exch].computed++;
      }
      shardsWrote.add(ctx.shard);
    }

    audit.tickersProcessed++;
    ckpt.add(ticker);

    // Progress + checkpoint every 50 tickers.
    if ((i + 1) % 50 === 0 || i === tickers.length - 1) {
      console.log(
        `  ${i + 1}/${tickers.length} tickers · computed=${audit.pointsComputed} · unavailable=${audit.pointsMarkedUnavailable} · pending=${audit.pointsLeftPending}`,
      );
      if (!DRY) {
        for (const s of shardsWrote) {
          const ent2 = [...candidatesByTicker.entries()].find(([, v]) => v.shard === s);
          if (!ent2) continue;
          const ctx2 = candidatesByTicker.get(ent2[0]);
          const body = ctx2.wrapped ? { ...ctx2.body, events: ctx2.events } : ctx2.events;
          fssync.writeFileSync(s, JSON.stringify(body, null, 2));
        }
        shardsWrote.clear();
        await writeCheckpoint(ckpt);
      }
    }
  }

  // Final flush.
  if (!DRY && shardsWrote.size > 0) {
    for (const s of shardsWrote) {
      const ent2 = [...candidatesByTicker.entries()].find(([, v]) => v.shard === s);
      if (!ent2) continue;
      const ctx2 = candidatesByTicker.get(ent2[0]);
      const body = ctx2.wrapped ? { ...ctx2.body, events: ctx2.events } : ctx2.events;
      fssync.writeFileSync(s, JSON.stringify(body, null, 2));
    }
    await writeCheckpoint(ckpt);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "backfill-reactions.json"), JSON.stringify(audit, null, 2));
  console.log(`\n=== backfill-reactions ===`);
  console.log(`Tickers processed:     ${audit.tickersProcessed}`);
  console.log(`Points computed:       ${audit.pointsComputed}`);
  console.log(`Points → unavailable:  ${audit.pointsMarkedUnavailable}`);
  console.log(`Points left pending:   ${audit.pointsLeftPending}`);
  console.log(`Per exchange:`);
  const rows = Object.entries(audit.perExchange).sort((a, b) => (b[1].computed + b[1].unavailable) - (a[1].computed + a[1].unavailable));
  for (const [ex, s] of rows) {
    console.log(`  ${ex.padEnd(4)} · computed=${s.computed} · unavailable=${s.unavailable} · pending=${s.pending}`);
  }
  console.log(`✓ audit → scripts/audits/backfill-reactions.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
