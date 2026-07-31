#!/usr/bin/env node
/**
 * Ingest Yahoo EPS estimates (with matching actuals) from
 * v10 quoteSummary earnings.earningsChart.quarterly for every
 * operating entity. For each past quarter Yahoo returns both
 * `actual.raw` and `estimate.raw` — the estimate is the consensus
 * captured before that report landed (Yahoo persists it). We use
 * both to backfill eps_usd.estimate on past events where missing,
 * then compute surprisePct = (actual - estimate) / |estimate| * 100.
 *
 * The daily cron ingests estimates ongoing but only for
 * currentQuarter (upcoming). This script backfills the ones that
 * were reported before the estimates ingest was wired up.
 *
 *   node scripts/ingest-eps-estimates.mjs [--dry] [--limit=N]
 *
 * Emits scripts/audits/ingest-eps-estimates.json with per-ticker
 * rollup (estimates attached, surprise computed, skipped).
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

const UA = "Mozilla/5.0 (ingest-eps-estimates)";
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

let CRUMB = null;
let COOKIE = "";
async function primeCrumb() {
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  const setCookies = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [];
  const pairs = new Map();
  for (const raw of setCookies) {
    const f = raw.split(";", 1)[0].trim();
    const eq = f.indexOf("=");
    if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1));
  }
  COOKIE = Array.from(pairs, ([n, v]) => `${n}=${v}`).join("; ");
  if (!COOKIE) return null;
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: COOKIE },
  });
  if (!r2.ok) return null;
  CRUMB = (await r2.text()).trim();
  return CRUMB;
}

async function fetchEarnings(symbol) {
  if (!CRUMB || !COOKIE) return { error: "no-crumb" };
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=earnings&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const quarterly = j?.quoteSummary?.result?.[0]?.earnings?.earningsChart?.quarterly ?? [];
    return { quarterly };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

// Yahoo's earningsChart label format is "1Q2026" → { year, quarter }.
function periodFromEarningsLabel(label) {
  const m = /^(\d)Q(\d{4})$/.exec(label ?? "");
  if (!m) return null;
  return { quarter: Number(m[1]), year: Number(m[2]), label: `FY${m[2]} Q${m[1]}` };
}

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
  console.log(`ingest-eps-estimates · dry=${DRY} limit=${LIMIT === Infinity ? "all" : LIMIT} concurrency=${CONCURRENCY}`);
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const targets = (reg.entities ?? []).filter(
    (e) =>
      e.securityType === "operating" &&
      typeof e.yahooSymbol === "string" &&
      e.yahooSymbol.length > 0 &&
      (!ONLY || ONLY.has(e.ticker)) &&
      (!SP500_ONLY || (e.index_membership ?? []).includes("SP500")),
  ).slice(0, LIMIT);
  console.log(`Targets: ${targets.length} operating entities with Yahoo symbols`);

  await primeCrumb();
  if (!CRUMB) { console.error("Yahoo crumb prime failed"); process.exit(1); }
  console.log(`crumb=${CRUMB.slice(0, 6)}…`);

  const nowIso = new Date().toISOString();
  const rollup = {
    schema: "ingest-eps-estimates/v1",
    generatedAt: nowIso,
    totals: {
      fetched: 0,
      fetchErrors: 0,
      empty: 0,
      shardsRead: 0,
      shardsWritten: 0,
      estimatesAttached: 0,
      surpriseComputed: 0,
      quartersSkipped: 0,
    },
    perEntity: [],
  };

  let processed = 0;
  await pool(targets, CONCURRENCY, async (entity) => {
    processed++;
    const r = await fetchEarnings(entity.yahooSymbol);
    rollup.totals.fetched++;
    if (r.error) {
      rollup.totals.fetchErrors++;
      rollup.perEntity.push({ ticker: entity.ticker, status: "fetch-error", detail: r.error });
      if (processed % 100 === 0) {
        console.log(
          `  ${processed}/${targets.length} · attached=${rollup.totals.estimatesAttached} · surprise=${rollup.totals.surpriseComputed} · shards=${rollup.totals.shardsWritten}`,
        );
      }
      return;
    }
    const quarterly = r.quarterly ?? [];
    if (quarterly.length === 0) {
      rollup.totals.empty++;
      rollup.perEntity.push({ ticker: entity.ticker, status: "empty" });
      return;
    }

    // Read shard.
    const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
    let shardRaw;
    try {
      shardRaw = JSON.parse(await fs.readFile(shardPath, "utf-8"));
      rollup.totals.shardsRead++;
    } catch {
      rollup.perEntity.push({ ticker: entity.ticker, status: "no-shard" });
      return;
    }
    const wrapped = !Array.isArray(shardRaw);
    const events = wrapped ? shardRaw.events ?? [] : shardRaw;
    const originalJson = JSON.stringify(events);

    const perEntity = { ticker: entity.ticker, attached: 0, surprise: 0, skipped: 0 };

    for (const q of quarterly) {
      // Our shards use inconsistent label styles across tickers:
      //   ACN US "FY2026 Q2" (calendar-quarter derived) vs
      //   NVDA US "FY2027 Q1" (fiscal-year derived).
      // Try MULTIPLE label sources — whichever finds a match wins.
      const candidateLabels = [
        periodFromEarningsLabel(q.date),
        periodFromEarningsLabel(q.calendarQuarter),
        periodFromEarningsLabel(q.fiscalQuarter),
      ].filter(Boolean);
      if (candidateLabels.length === 0) { perEntity.skipped++; continue; }
      const actualRaw = q.actual?.raw;
      const estimateRaw = q.estimate?.raw;
      // Need estimate; actual optional (some upcoming quarters slip in as
      // past on Yahoo's chart before their earnings date).
      if (estimateRaw == null) { perEntity.skipped++; continue; }

      // Find matching past event. Prefer periodEndDate proximity —
      // it's the authoritative signal from Yahoo (the fiscal
      // quarter-end this row reports on), and it doesn't suffer
      // from the label-format inconsistencies our shards accumulated
      // across different ingest generations. Fall back to label
      // matching when Yahoo doesn't provide periodEndDate.
      let target = null;
      const periodEnd = q.periodEndDate?.fmt;
      if (periodEnd) {
        // Pick the event whose eventDate is closest to the fiscal
        // period end, within a 60-day window (report date typically
        // 2-8 weeks after quarter end for SEC filers).
        const candidates = events
          .filter((ev) => ev.eventDate)
          .map((ev) => ({
            ev,
            gap: Math.abs(new Date(ev.eventDate) - new Date(periodEnd)) / 86_400_000,
          }))
          .filter((c) => c.gap <= 60)
          .sort((a, b) => a.gap - b.gap);
        target = candidates[0]?.ev ?? null;
      }
      if (!target) {
        for (const p of candidateLabels) {
          target = events.find((ev) => ev.eventDate && ev.period === p.label);
          if (target) break;
        }
      }
      if (!target) { perEntity.skipped++; continue; }

      if (!Array.isArray(target.metrics)) target.metrics = [];
      let m = target.metrics.find((x) => x.key === "eps_usd");
      if (!m) {
        m = {
          key: "eps_usd",
          displayLabel: "EPS",
          isHeadline: entity.headlineMetrics?.includes("eps_usd") ?? false,
          surprisePct: null,
          estimate: null,
          actual: null,
          prior: null,
        };
        target.metrics.push(m);
      }

      // Only add estimate if missing (never overwrite manual/SEC-filed).
      if (!m.estimate || m.estimate.value == null) {
        m.estimate = {
          value: estimateRaw,
          unit: entity.currency ?? "USD",
          source: {
            url: `https://finance.yahoo.com/quote/${encodeURIComponent(entity.yahooSymbol)}/analysis`,
            label: "Yahoo · earningsChart (consensus)",
            provenance: "wire",
            locator: null,
          },
          asOf: target.eventDate,
          fetchedAt: nowIso,
          method: "yahoo",
          confidence: 0.75,
        };
        perEntity.attached++;
        rollup.totals.estimatesAttached++;
      }

      // Compute surprise if both actual and estimate are non-null.
      const actualVal = m.actual?.value;
      const estimateVal = m.estimate?.value;
      if (
        actualVal != null &&
        estimateVal != null &&
        Math.abs(estimateVal) > 1e-9 &&
        (m.surprisePct == null || Number.isNaN(m.surprisePct))
      ) {
        m.surprisePct = ((actualVal - estimateVal) / Math.abs(estimateVal)) * 100;
        perEntity.surprise++;
        rollup.totals.surpriseComputed++;
      }
    }

    const nextJson = JSON.stringify(events);
    if (nextJson !== originalJson && !DRY) {
      const body = wrapped ? { ...shardRaw, events } : events;
      fssync.writeFileSync(shardPath, JSON.stringify(body, null, 2));
      rollup.totals.shardsWritten++;
      perEntity.status = "written";
    } else if (nextJson === originalJson) {
      perEntity.status = "unchanged";
    } else {
      perEntity.status = "dry-would-write";
    }
    rollup.perEntity.push(perEntity);

    if (processed % 100 === 0 || processed === targets.length) {
      console.log(
        `  ${processed}/${targets.length} · attached=${rollup.totals.estimatesAttached} · surprise=${rollup.totals.surpriseComputed} · shards=${rollup.totals.shardsWritten}`,
      );
    }
  });

  console.log(`\n=== ingest-eps-estimates ===`);
  console.log(`Entities scanned:         ${processed}`);
  console.log(`Fetch errors:             ${rollup.totals.fetchErrors}`);
  console.log(`Empty earnings:           ${rollup.totals.empty}`);
  console.log(`Shards read:              ${rollup.totals.shardsRead}`);
  console.log(`Shards written:           ${rollup.totals.shardsWritten}`);
  console.log(`Estimates attached:       ${rollup.totals.estimatesAttached}`);
  console.log(`Surprise% computed:       ${rollup.totals.surpriseComputed}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "ingest-eps-estimates.json"),
    JSON.stringify(rollup, null, 2),
  );
  console.log(`✓ audit → scripts/audits/ingest-eps-estimates.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
