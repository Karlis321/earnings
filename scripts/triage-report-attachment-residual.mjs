#!/usr/bin/env node
/**
 * Triage the ~150 US-primary tickers still failing the report-
 * attachment rule (reported_without_document ≠ 0). Per prompt1.txt
 * the population splits into 4 subclasses each with a different
 * remedy:
 *
 *   1. FOREIGN-PRIMARY ADR — the entity has a US ticker but its CIK
 *      files only 6-K / 20-F / 40-F (foreign issuer forms). SEC's
 *      10-Q/10-K path doesn't apply; the document rule follows the
 *      home venue (irSources), separately tracked. Route to
 *      structural bucket via entity.secFilerType = "foreign".
 *
 *   2. FISCAL-OFFSET TAIL — the CIK files 10-Q/10-K normally, but
 *      the eventDate on our shard is a Yahoo quarter-end placeholder
 *      whose distance from any SEC filingDate/reportDate exceeds our
 *      30-day pickBestFiling window. Solvable by widening the
 *      window and/or matching by fiscal period alignment.
 *
 *   3. CORPORATE-ACTION CASE — CIK on entity is wrong: recent split
 *      (LLYVK from Liberty Media), spin-off (ECG from MDU), new
 *      listing (ABXX). Correct CIK exists — need to look it up
 *      manually.
 *
 *   4. TRUE RESIDUAL — everything left after 1-3. Per-ticker
 *      escalation ladder: mechanical → irSources → research → demote
 *      to shell with a note if nothing found.
 *
 * Emits scripts/audits/triage-report-attachment.json with per-ticker
 * class + evidence. No writes to registry or shards; this is the
 * classifier + audit output.
 *
 *   node scripts/triage-report-attachment-residual.mjs
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
const OUT_PATH = path.join(ROOT, "scripts", "audits", "triage-report-attachment.json");
const SEC_UA = "earnings-dashboard karlis@example.com";

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

let secLastFetchAt = 0;
async function fetchEdgar(url) {
  const wait = Math.max(0, 1000 - (Date.now() - secLastFetchAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  secLastFetchAt = Date.now();
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { data: await r.json() };
  } catch (e) {
    return { error: e.message };
  }
}

function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

function violatingEvents(shard) {
  const evs = Array.isArray(shard) ? shard : (shard.events ?? []);
  return evs.filter((e) => {
    if (!e.eventDate) return false;
    const hasActuals = (e.metrics ?? []).some((m) => m.actual?.value != null);
    if (!hasActuals) return false;
    const link = e.sourceLink;
    return !(link && link.kind === "filing" && link.url && !/google\.com\/search/i.test(link.url));
  });
}

function loadShard(ticker) {
  try {
    return JSON.parse(fssync.readFileSync(path.join(EVENTS_DIR, tickerSlug(ticker) + ".json"), "utf-8"));
  } catch { return null; }
}

async function classifyTicker(entity, entities) {
  const shard = loadShard(entity.ticker);
  if (!shard) return null;
  const violations = violatingEvents(shard);
  if (violations.length === 0) return null;

  const { data: subs, error } = await fetchEdgar(
    `https://data.sec.gov/submissions/CIK${String(entity.edgarCik).padStart(10, "0")}.json`,
  );
  const forms = new Set();
  let filingRows = [];
  if (subs?.filings?.recent) {
    const r = subs.filings.recent;
    for (let i = 0; i < (r.form?.length ?? 0); i++) {
      forms.add(r.form[i]);
      filingRows.push({ form: r.form[i], filingDate: r.filingDate[i], reportDate: r.reportDate?.[i] });
    }
  }

  // Rule 1: FOREIGN-PRIMARY ADR — no 10-Q or 10-K in recent history.
  //         (20-F/40-F/6-K only.)
  const hasDomesticQuarterlies = forms.has("10-Q") || forms.has("10-K");
  const hasForeignForms = forms.has("6-K") || forms.has("20-F") || forms.has("40-F");
  if (!hasDomesticQuarterlies && (hasForeignForms || forms.size > 0)) {
    return {
      ticker: entity.ticker,
      class: "foreign-primary-adr",
      violations: violations.length,
      cik: entity.edgarCik,
      formsFound: [...forms],
      evidence: `no 10-Q/10-K in ${forms.size} recent filings; ${[...forms].filter((f) => /20-F|40-F|6-K/.test(f)).join(", ") || "foreign forms"} only`,
    };
  }

  // Rule 3: CORPORATE-ACTION / bad CIK — no filings at all, or only
  //         S-8/8-K without any quarterly reports.
  if (!hasDomesticQuarterlies && !hasForeignForms) {
    return {
      ticker: entity.ticker,
      class: "corporate-action-or-bad-cik",
      violations: violations.length,
      cik: entity.edgarCik,
      formsFound: [...forms],
      evidence: forms.size === 0 ? "no recent filings on this CIK" : `no quarterly/annual reports; forms present: ${[...forms].join(", ")}`,
      subsError: error,
    };
  }

  // Rule 2: FISCAL-OFFSET TAIL — has 10-Q/10-K but none matched our
  //         event dates. Report per-event the nearest filing gap so
  //         we can see why the matcher missed.
  const evidencePerEvent = [];
  const quarterlies = filingRows.filter((r) => /^(10-Q|10-K|8-K)$/.test(r.form));
  for (const ev of violations) {
    let bestGap = Infinity;
    let bestForm = null;
    let bestDate = null;
    for (const f of quarterlies) {
      const gap = Math.min(
        daysBetween(f.filingDate, ev.eventDate),
        f.reportDate ? daysBetween(f.reportDate, ev.eventDate) : Infinity,
      );
      if (gap < bestGap) { bestGap = gap; bestForm = f.form; bestDate = f.filingDate; }
    }
    evidencePerEvent.push({
      period: ev.period,
      eventDate: ev.eventDate,
      nearestForm: bestForm,
      nearestFilingDate: bestDate,
      nearestGapDays: bestGap === Infinity ? null : Math.round(bestGap),
    });
  }
  return {
    ticker: entity.ticker,
    class: "fiscal-offset-or-tail",
    violations: violations.length,
    cik: entity.edgarCik,
    formsFound: [...forms],
    events: evidencePerEvent,
  };
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx]); } catch (e) { console.error("worker err:", e.message); }
    }
  });
  await Promise.all(workers);
}

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = reg.entities ?? [];
  // Build the set of US-primary CIK-bearing tickers that still have
  // report-attachment violations.
  const suspects = entities.filter(
    (e) => e.ticker.endsWith(" US") && e.edgarCik,
  ).filter((e) => {
    const shard = loadShard(e.ticker);
    return shard ? violatingEvents(shard).length > 0 : false;
  });

  console.log(`triage-report-attachment · ${suspects.length} US-primary CIK-bearing tickers with violations`);

  const results = [];
  await pool(suspects, 1, async (e) => { // SEC 1 req/s = concurrency 1
    const r = await classifyTicker(e, entities);
    if (r) results.push(r);
    if (results.length % 25 === 0) {
      console.log(`  ${results.length}/${suspects.length}`);
    }
  });

  const byClass = { "foreign-primary-adr": [], "corporate-action-or-bad-cik": [], "fiscal-offset-or-tail": [] };
  for (const r of results) byClass[r.class].push(r);

  console.log(`\n=== triage-report-attachment ===`);
  console.log(`  foreign-primary-adr:         ${byClass["foreign-primary-adr"].length}`);
  console.log(`  corporate-action-or-bad-cik: ${byClass["corporate-action-or-bad-cik"].length}`);
  console.log(`  fiscal-offset-or-tail:       ${byClass["fiscal-offset-or-tail"].length}`);
  console.log();

  for (const [cls, rows] of Object.entries(byClass)) {
    if (rows.length === 0) continue;
    console.log(`--- ${cls} (${rows.length}) ---`);
    for (const r of rows.slice(0, 20)) {
      console.log(`  ${r.ticker.padEnd(12)} cik=${r.cik} v=${r.violations} · ${r.evidence ?? "see events[]"}`);
    }
    if (rows.length > 20) console.log(`  …+${rows.length - 20} more`);
  }

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify({
    schema: "triage-report-attachment/v1",
    generatedAt: new Date().toISOString(),
    counts: {
      total: results.length,
      "foreign-primary-adr": byClass["foreign-primary-adr"].length,
      "corporate-action-or-bad-cik": byClass["corporate-action-or-bad-cik"].length,
      "fiscal-offset-or-tail": byClass["fiscal-offset-or-tail"].length,
    },
    results,
  }, null, 2));
  console.log(`\n  audit → ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
