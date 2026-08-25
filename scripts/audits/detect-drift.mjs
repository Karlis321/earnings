#!/usr/bin/env node
/**
 * Compare the latest /audit artifact in scripts/audits/history/ to
 * the immediately-prior one. Exits non-zero if drift is detected.
 *
 *   node scripts/audits/detect-drift.mjs
 *
 * Drift signals (any one fires red):
 *   1. NEW reason string in pipeline-report.reasons[] not on the
 *      KNOWN_EXCEPTIONS allowlist.
 *   2. NEW hallucination candidate in §F17 reconcile (any AI value
 *      resolving to no deterministic source).
 *   3. standing-tests regressed (D14.ok flipped true → false).
 *   4. reported_without_document INCREASED vs last week.
 *   5. §F15 counters that grew (events_total dropping to 0 while
 *      previously > 0 = silent-zero phase).
 *
 * READ-ONLY: no writes to data/, no fixes. Prints a report to
 * stdout; exit 0 = quiet, exit 1 = drift detected.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --history <dir> override lets the fires-and-clears spec point at
// a synthetic temp directory without touching real history/.
const dirIdx = process.argv.indexOf("--history");
const HISTORY_DIR = dirIdx >= 0
  ? path.resolve(process.argv[dirIdx + 1])
  : path.join(__dirname, "history");

// KNOWN_EXCEPTIONS — MUST match the allowlist in
// scripts/test-standing.mjs. Duplicated intentionally to keep this
// script standalone; if you add/remove entries, update BOTH files.
const KNOWN_EXCEPTIONS = [
  "reported_without_document",
];

function reasonAllowed(reason) {
  return KNOWN_EXCEPTIONS.some((prefix) => reason.startsWith(prefix));
}

async function loadHistory() {
  try {
    const files = (await fs.readdir(HISTORY_DIR))
      .filter((f) => /^full-audit-.*\.json$/.test(f))
      .sort();
    return files.map((f) => path.join(HISTORY_DIR, f));
  } catch {
    return [];
  }
}

function pickHallucinationKey(f) {
  // Stable key per finding so we can diff across runs.
  const ev = f.evidence ?? {};
  return `${f.section}|${ev.theme ?? ""}|${ev.ticker ?? ""}|${(ev.headline ?? "").slice(0, 60)}`;
}

async function main() {
  const files = await loadHistory();
  if (files.length === 0) {
    console.log("no history/*.json artifacts — first-run baseline, nothing to compare.");
    process.exit(0);
  }
  const latestPath = files[files.length - 1];
  const latest = JSON.parse(await fs.readFile(latestPath, "utf-8"));

  if (files.length === 1) {
    console.log(`baseline established: ${path.basename(latestPath)}`);
    console.log(`  no prior artifact to compare against — quiet.`);
    process.exit(0);
  }

  const priorPath = files[files.length - 2];
  const prior = JSON.parse(await fs.readFile(priorPath, "utf-8"));
  console.log(`comparing ${path.basename(latestPath)}`);
  console.log(`     with ${path.basename(priorPath)}`);
  console.log("");

  const drift = [];

  // 1. New reason strings not on the allowlist
  const latestReasons = new Set(latest.sections.F15_pipeline?.reasons ?? []);
  const priorReasons = new Set(prior.sections.F15_pipeline?.reasons ?? []);
  for (const r of latestReasons) {
    if (priorReasons.has(r)) continue;
    if (reasonAllowed(r)) continue;
    drift.push({
      signal: "NEW_REASON_UNKNOWN",
      msg: `new pipeline-report reason not on allowlist: "${r}"`,
    });
  }

  // 2. New hallucination candidates
  const priorHall = new Set(
    (prior.findings ?? [])
      .filter((f) => f.severity === "HALLUCINATION")
      .map(pickHallucinationKey),
  );
  const latestHall = (latest.findings ?? []).filter(
    (f) => f.severity === "HALLUCINATION",
  );
  for (const f of latestHall) {
    if (priorHall.has(pickHallucinationKey(f))) continue;
    drift.push({
      signal: "NEW_HALLUCINATION",
      msg: `${f.section} · ${f.msg}`,
    });
  }

  // 3. standing-tests regressed
  const priorD14 = prior.sections.D14?.ok !== false;
  const latestD14 = latest.sections.D14?.ok !== false;
  if (priorD14 && !latestD14) {
    drift.push({
      signal: "STANDING_TESTS_REGRESSION",
      msg: `standing-tests were green, now red`,
    });
  }

  // 4. reported_without_document increased. Prefer the raw counter
  // stamped by full-audit.mjs; fall back to parsing reasons[] on
  // older artifacts that predate that field.
  const parseRWD = (rep) => {
    if (typeof rep?.reported_without_document === "number") {
      return rep.reported_without_document;
    }
    for (const r of rep?.reasons ?? []) {
      const m = r.match(/reported_without_document=(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };
  const priorRWDCount = parseRWD(prior.sections.F15_pipeline);
  const latestRWDCount = parseRWD(latest.sections.F15_pipeline);
  if (
    typeof priorRWDCount === "number" &&
    typeof latestRWDCount === "number" &&
    latestRWDCount > priorRWDCount
  ) {
    drift.push({
      signal: "RWD_INCREASED",
      msg: `reported_without_document rose ${priorRWDCount} → ${latestRWDCount}`,
    });
  }

  // 5. events_total silent-zero (any counter that was >0 → 0)
  const cmpNumericDrop = (label, priorVal, latestVal) => {
    if (typeof priorVal !== "number" || typeof latestVal !== "number") return;
    if (priorVal > 0 && latestVal === 0) {
      drift.push({
        signal: "SILENT_ZERO",
        msg: `${label} was ${priorVal}, now 0 (phase output collapsed)`,
      });
    }
  };
  cmpNumericDrop(
    "F15.events_total",
    prior.sections.F15_pipeline?.events_total,
    latest.sections.F15_pipeline?.events_total,
  );
  cmpNumericDrop(
    "F15.reactions_computed",
    prior.sections.F15_pipeline?.reactions_computed,
    latest.sections.F15_pipeline?.reactions_computed,
  );

  // Headline deltas — always print, drift or no
  console.log("=== headline deltas ===");
  const cmp = (label, p, l) => {
    if (typeof p === "number" && typeof l === "number") {
      const sign = l - p > 0 ? "+" : l - p < 0 ? "" : "±";
      console.log(`  ${label}: ${p} → ${l}  (${sign}${l - p})`);
    } else {
      console.log(`  ${label}: ${p} → ${l}`);
    }
  };
  cmp("events_total", prior.sections.F15_pipeline?.events_total, latest.sections.F15_pipeline?.events_total);
  cmp("reactions_computed", prior.sections.F15_pipeline?.reactions_computed, latest.sections.F15_pipeline?.reactions_computed);
  cmp("reported_without_document", priorRWDCount, latestRWDCount);
  cmp("standing-tests OK?", prior.sections.D14?.ok, latest.sections.D14?.ok);
  cmp("hallucinations", (prior.findings ?? []).filter((f) => f.severity === "HALLUCINATION").length, (latest.findings ?? []).filter((f) => f.severity === "HALLUCINATION").length);
  console.log("");

  if (drift.length === 0) {
    console.log("=== quiet — no drift ===");
    process.exit(0);
  }

  console.log("=== DRIFT DETECTED ===");
  for (const d of drift) console.log(`  [${d.signal}] ${d.msg}`);
  console.log(`\n${drift.length} drift signal(s) — audit-daily will go red.`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
