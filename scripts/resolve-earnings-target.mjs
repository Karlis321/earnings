#!/usr/bin/env node
/**
 * Step-0 resolver for the /earnings command. Does every local read the
 * summary flow needs in a single deterministic call and prints one JSON
 * object to stdout. The caller never has to run grep, jq, node -e, or
 * shell arithmetic — this script is the single source of Step-0 truth.
 *
 *   node scripts/resolve-earnings-target.mjs <TICKER> [PERIOD]
 *
 * Behaviour:
 *   - Ticker with " " (e.g. "HBM US") — resolves to the canonical member
 *     of the entity's companyId. Any registered member ticker works as
 *     input; the returned canonicalTicker is what the summary file
 *     uses.
 *   - PERIOD optional (e.g. "FY2026 Q2"). If omitted, uses the latest
 *     past event (max eventDate).
 *   - summaryExists: true iff data/summaries/<T>_<P>.json exists AND
 *     the validator returns exit 0 on it. So a stale/malformed summary
 *     doesn't shortcut the pipeline.
 *   - kpis: every populated metric from the target event, plus
 *     prior_qq (previous event in same shard) and prior_yy (event ~4
 *     quarters back — matched by fiscal-year+quarter arithmetic).
 *
 * Exit codes:
 *   0 — target resolved cleanly, JSON on stdout
 *   2 — ticker unknown OR period not in shard OR shard missing
 *   1 — unexpected I/O error
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const SUMMARIES_DIR = path.join(ROOT, "data", "summaries");

function tickerSlug(ticker) {
  return ticker.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}
function periodSlug(period) {
  return period.replace(/\s+/g, "_");
}

function die(code, msg) {
  process.stderr.write(`resolve-earnings-target: ${msg}\n`);
  process.exit(code);
}

// FY2026 Q3 -> FY2025 Q3 (subtract 4 quarters, so year-1)
function priorYearPeriod(period) {
  const m = /^FY(\d{4}) Q([1-4])$/.exec(period ?? "");
  if (!m) return null;
  return `FY${Number(m[1]) - 1} Q${m[2]}`;
}

function extractKpi(metric) {
  if (!metric?.actual || metric.actual.value == null) return null;
  return {
    value: metric.actual.value,
    unit: metric.actual.unit ?? null,
    source_label: metric.actual.source?.label ?? null,
    provenance: metric.actual.source?.provenance ?? null,
    derived: !!metric.actual.derived,
  };
}

function collectKpis(event, priorQq, priorYy) {
  const out = {};
  for (const m of event.metrics ?? []) {
    const cur = extractKpi(m);
    if (!cur) continue;
    const qq = priorQq ? extractKpi((priorQq.metrics ?? []).find((x) => x.key === m.key)) : null;
    const yy = priorYy ? extractKpi((priorYy.metrics ?? []).find((x) => x.key === m.key)) : null;
    out[m.key] = {
      value: cur.value,
      unit: cur.unit,
      source_label: cur.source_label,
      provenance: cur.provenance,
      derived: cur.derived,
      prior_qq: qq,
      prior_yy: yy,
    };
  }
  return out;
}

function validateSummary(summaryPath) {
  const script = path.join(ROOT, "scripts", "validate.js");
  const r = spawnSync(process.execPath, [script, summaryPath], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  return r.status === 0;
}

function main() {
  const inputTicker = process.argv[2];
  const inputPeriod = process.argv[3];
  if (!inputTicker) die(2, "usage: resolve-earnings-target.mjs <TICKER> [PERIOD]");

  let reg;
  try { reg = JSON.parse(fs.readFileSync(REG_PATH, "utf-8")); }
  catch (e) { die(1, `cannot read registry — ${e.message}`); }

  const entities = reg.entities ?? [];
  const input = entities.find((e) => e.ticker === inputTicker);
  if (!input) die(2, `ticker not in registry: "${inputTicker}"`);

  // Resolve to canonical via companyId if the input isn't already canonical.
  let canonical = input;
  if (input.isCanonical === false && input.companyId) {
    const sibs = entities.filter((e) => e.companyId === input.companyId);
    const canon = sibs.find((e) => e.isCanonical !== false);
    if (canon) canonical = canon;
  }

  const shardPath = path.join(EVENTS_DIR, tickerSlug(canonical.ticker) + ".json");
  if (!fs.existsSync(shardPath)) {
    die(2, `no shard for canonical ticker "${canonical.ticker}" at ${shardPath}`);
  }
  const shard = JSON.parse(fs.readFileSync(shardPath, "utf-8"));
  const events = Array.isArray(shard) ? shard : shard.events ?? [];
  const past = events.filter((e) => e.eventDate).sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));

  let target;
  if (inputPeriod) {
    target = past.find((e) => e.period === inputPeriod);
    if (!target) die(2, `period "${inputPeriod}" not in shard for ${canonical.ticker}`);
  } else {
    target = past[0];
    if (!target) die(2, `no past events on shard for ${canonical.ticker}`);
  }

  // Prior q/q: the next-oldest event (past is sorted desc).
  const idx = past.indexOf(target);
  const priorQq = idx >= 0 && idx + 1 < past.length ? past[idx + 1] : null;
  // Prior y/y: the event matching FY(target.year-1) Q(target.q).
  const yyLabel = priorYearPeriod(target.period);
  const priorYy = yyLabel ? past.find((e) => e.period === yyLabel) : null;

  const summaryPath = path.join(
    SUMMARIES_DIR,
    `${tickerSlug(canonical.ticker)}_${periodSlug(target.period)}.json`,
  );
  const summaryExistsRaw = fs.existsSync(summaryPath);
  const summaryValidates = summaryExistsRaw ? validateSummary(summaryPath) : false;

  const out = {
    canonicalTicker: canonical.ticker,
    companyId: canonical.companyId ?? null,
    edgarCik: canonical.edgarCik ?? null,
    displayName: canonical.displayName ?? canonical.legalName ?? null,
    reportingCurrency: canonical.currency ?? null,
    securityType: canonical.securityType ?? null,
    coverage: canonical.coverage ?? null,
    period: target.period,
    eventDate: target.eventDate,
    provenance: target.provenance ?? null,
    sourceLink: target.sourceLink ?? null,
    priorPeriodQq: priorQq?.period ?? null,
    priorPeriodYy: priorYy?.period ?? null,
    summaryPath: path.relative(ROOT, summaryPath).split(path.sep).join("/"),
    summaryExists: summaryExistsRaw,
    summaryValidates,
    // Combined "already done" signal: exists AND validates. This is the
    // condition the /earnings guard should key on.
    summaryReady: summaryExistsRaw && summaryValidates,
    kpis: collectKpis(target, priorQq, priorYy),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

try { main(); }
catch (e) { die(1, `unhandled — ${e.stack ?? e.message ?? e}`); }
