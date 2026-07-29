#!/usr/bin/env node
/**
 * Ingest analyst revenue estimates from Yahoo's v10 quoteSummary
 * `earningsTrend` module. That module carries `revenueEstimate` +
 * `earningsEstimate` per period (period keys `0q`, `+1q`, `0y`, `+1y`);
 * our existing EPS ingest via `earnings.earningsChart` only returns
 * EPS, which is why revenue never had estimates on the shard.
 *
 * Scope for v1: covered-tier tickers (data/covered.json) — that's the
 * 17 names where analyst coverage is deepest and where the /earnings
 * summaries live. Wider-universe ingest is a later step (see prompt1
 * item 6 comment about "mechanical/KPI-only mode for the wider
 * universe").
 *
 * Attachment rule: the estimate goes onto the ticker's UPCOMING event
 * whose scheduledDate falls in Yahoo's `endDate` quarter. Past events
 * NEVER get retroactive estimates — analyst-consensus-before-report
 * is a captured-in-time fact, not something we backdate. If no
 * matching upcoming event exists on the shard, we skip that period.
 *
 *   node scripts/ingest-revenue-estimates.mjs           # write
 *   node scripts/ingest-revenue-estimates.mjs --dry     # report only
 *
 * Reports per-ticker: analysts, estimate avg/low/high with unit,
 * attach target (period + eventId), and any skips with reason. Ends
 * with a summary: how many tickers gained estimates.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const COVERED_PATH = path.join(ROOT, "data", "covered.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const DRY = process.argv.includes("--dry");
const UA = "Mozilla/5.0 (ingest-revenue-estimates)";
const INTERVAL_MS = 1500;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function periodFromEndDate(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `FY${y} Q${q}`;
}

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

async function fetchEarningsTrend(symbol) {
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=earningsTrend&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: COOKIE },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const trend = j?.quoteSummary?.result?.[0]?.earningsTrend?.trend ?? [];
    return { trend };
  } catch (e) {
    return { error: e.message ?? "network" };
  }
}

async function loadCovered() {
  const raw = await fs.readFile(COVERED_PATH, "utf-8");
  const j = JSON.parse(raw);
  return Array.isArray(j.tickers) ? j.tickers : [];
}

async function main() {
  console.log(`ingest-revenue-estimates · dry=${DRY}`);
  await primeCrumb();
  if (!CRUMB) { console.error("crumb prime failed"); process.exit(1); }

  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const yahooByTicker = new Map();
  for (const e of reg.entities ?? []) {
    if (e.yahooSymbol) yahooByTicker.set(e.ticker, e.yahooSymbol);
  }
  const covered = await loadCovered();
  console.log(`Covered tickers: ${covered.length}`);

  const audit = {
    schema: "revenue-estimates/v1",
    generatedAt: new Date().toISOString(),
    perTicker: [],
    tickersWithEstimates: 0,
    estimatesAttached: 0,
  };
  const nowIso = new Date().toISOString();

  for (const [i, ticker] of covered.entries()) {
    const sym = yahooByTicker.get(ticker);
    if (!sym) {
      audit.perTicker.push({ ticker, status: "no-yahoo-symbol" });
      continue;
    }
    process.stdout.write(`  [${i + 1}/${covered.length}] ${ticker.padEnd(10)} → ${sym.padEnd(10)}`);
    const r = await fetchEarningsTrend(sym);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));

    if (r.error || !r.trend) {
      audit.perTicker.push({ ticker, yahoo: sym, status: "yahoo-error", detail: r.error ?? "empty" });
      console.log(" [err]");
      continue;
    }
    // Read the shard once and mutate in-memory before writing back.
    const shardPath = path.join(EVENTS_DIR, tickerSlug(ticker) + ".json");
    let shard;
    try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); }
    catch { audit.perTicker.push({ ticker, status: "no-shard" }); console.log(" [no-shard]"); continue; }
    const events = Array.isArray(shard) ? shard : (shard.events ?? []);

    const attachments = [];
    for (const t of r.trend) {
      // Only 0q and +1q are near-term forecasts we can meaningfully
      // attach to a scheduled event; 0y/+1y are annual aggregates that
      // don't map to a single quarterly event.
      if (t.period !== "0q" && t.period !== "+1q") continue;
      const endDate = t.endDate;
      if (!endDate) continue;
      const targetPeriod = periodFromEndDate(endDate);
      const revEst = t.revenueEstimate ?? {};
      const avg = revEst.avg?.raw ?? null;
      const low = revEst.low?.raw ?? null;
      const high = revEst.high?.raw ?? null;
      const analysts = revEst.numberOfAnalysts?.raw ?? null;
      if (avg == null) continue;

      // Find the upcoming event on this ticker's shard whose period
      // matches, or (fallback) whose scheduledDate lands in that
      // quarter and eventDate is not set (upcoming).
      const target = events.find(
        (e) => e.period === targetPeriod && !e.eventDate,
      );
      if (!target) {
        attachments.push({
          period: targetPeriod,
          status: "no-matching-upcoming-event",
          revenue_avg_usd: avg,
          analysts,
        });
        continue;
      }

      if (!Array.isArray(target.metrics)) target.metrics = [];
      let m = target.metrics.find((x) => x.key === "revenue_usd_m");
      if (!m) {
        m = {
          key: "revenue_usd_m",
          displayLabel: "Revenue (M)",
          isHeadline: false,
          surprisePct: null,
          estimate: null,
          actual: null,
          prior: null,
        };
        target.metrics.push(m);
      }
      m.estimate = {
        value: avg / 1_000_000, // Yahoo returns raw dollars; our metric key is _usd_m (millions)
        unit: "USD",
        source: {
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/analysis`,
          label: `Yahoo · earningsTrend (${analysts ?? "?"} analysts)`,
          provenance: "wire",
          locator: null,
        },
        asOf: endDate,
        fetchedAt: nowIso,
        method: "yahoo",
        confidence: 0.75,
      };
      // Additional shape kept out of the Fact interface — low/high band
      // is useful context for the UI's fact popover.
      m.estimate.low_usd_m = low != null ? low / 1_000_000 : null;
      m.estimate.high_usd_m = high != null ? high / 1_000_000 : null;
      m.estimate.numberOfAnalysts = analysts;
      attachments.push({
        period: targetPeriod,
        status: "attached",
        eventId: target.id,
        revenue_avg_usd_m: avg / 1_000_000,
        low_usd_m: low != null ? low / 1_000_000 : null,
        high_usd_m: high != null ? high / 1_000_000 : null,
        analysts,
      });
      audit.estimatesAttached++;
    }
    audit.perTicker.push({ ticker, yahoo: sym, status: "ok", attachments });
    if (attachments.some((a) => a.status === "attached")) audit.tickersWithEstimates++;

    // Rewrite shard only when at least one attachment happened.
    if (!DRY && attachments.some((a) => a.status === "attached")) {
      const body = Array.isArray(shard) ? events : { ...shard, events };
      await fs.writeFile(shardPath, JSON.stringify(body, null, 2));
    }
    console.log(` [${attachments.filter((a) => a.status === "attached").length} attached]`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const auditPath = path.join(OUT_DIR, "revenue-estimates.json");
  await fs.writeFile(auditPath, JSON.stringify(audit, null, 2));

  console.log(`\n=== ingest-revenue-estimates ===`);
  console.log(`Covered tickers scanned:   ${covered.length}`);
  console.log(`Tickers gained estimates:  ${audit.tickersWithEstimates}`);
  console.log(`Total estimates attached:  ${audit.estimatesAttached}`);
  console.log(`✓ audit → ${auditPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
