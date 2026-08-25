#!/usr/bin/env node
/**
 * Fires-and-clears spec for scripts/audits/detect-drift.mjs and the
 * READ-ONLY grep-guard in audit-daily.yml.
 *
 *   node scripts/audits/detect-drift.spec.mjs
 *
 * Standalone. Synthetic fixtures only — creates a scratch dir under
 * the OS temp path, writes minimal JSONs, runs detect-drift.mjs
 * against that dir. Never reads or writes real scripts/audits/history/
 * or real data/. Not wired into daily-tests, CI, or push hooks.
 *
 * Six cases:
 *   1. NEW unrecognized reason in reasons[]         → red (drift)
 *   2. NEW hallucination candidate in §F17         → red
 *   3. Standing-tests regressed (green → red)      → red
 *   4. reported_without_document increased          → red
 *   5. Silent-zero (events_total >0 → 0)            → red
 *   6. Clean current == prior (no drift)            → green
 *   7. audit-daily grep-guard fires on
 *      a staged file outside scripts/audits/history/ → red
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DETECT_DRIFT = path.join(__dirname, "detect-drift.mjs");

const results = [];
let passCount = 0, failCount = 0;

function record(name, expected, actualExit, evidence) {
  const pass =
    (expected === "red" && actualExit !== 0) ||
    (expected === "green" && actualExit === 0);
  const badge = pass ? "PASS" : "FAIL";
  console.log(`  [${badge}] ${name} · expected=${expected} · exit=${actualExit}`);
  for (const line of evidence) console.log(`      ${line}`);
  results.push({ name, expected, actualExit, pass });
  if (pass) passCount++;
  else failCount++;
}

// Minimum shape that detect-drift.mjs actually reads (see the
// script for the fields it inspects — sections.F15_pipeline,
// sections.D14.ok, findings[] with severity HALLUCINATION).
function baseArtifact(overrides = {}) {
  const base = {
    schema: "audit-report/v1",
    generatedAt: "2026-08-01T00:00:00.000Z",
    sections: {
      D14: { ok: true, tail: "" },
      F15_pipeline: {
        status: "ok",
        reasons: [],
        events_total: 21000,
        reactions_computed: 70000,
        duplicates_detected: 0,
        reported_without_document: 12,
        reported_without_document_structural: 9000,
        sp500_complete_pct: 97.4,
      },
    },
    findings: [],
    unverified: [],
  };
  return deepMerge(base, overrides);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a[k]) {
      out[k] = deepMerge(a[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function runDrift(historyDir) {
  const r = spawnSync(
    "node",
    [DETECT_DRIFT, "--history", historyDir],
    { encoding: "utf-8" },
  );
  return { exit: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function writeArtifacts(dir, prior, latest) {
  fs.mkdirSync(dir, { recursive: true });
  // detect-drift picks the alphabetically-last file as "latest".
  // Timestamps chosen so latest > prior.
  fs.writeFileSync(
    path.join(dir, "full-audit-2026-01-01T00-00-00Z.json"),
    JSON.stringify(prior),
  );
  fs.writeFileSync(
    path.join(dir, "full-audit-2026-01-08T00-00-00Z.json"),
    JSON.stringify(latest),
  );
}

function mkScratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "drift-spec-"));
}

function rmScratch(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log("=== detect-drift.spec · fires-and-clears ===\n");

// -----------------------------------------------------------
// 1. NEW unrecognized reason (not on KNOWN_EXCEPTIONS)
// -----------------------------------------------------------
{
  const dir = mkScratch();
  try {
    const prior = baseArtifact();
    const latest = baseArtifact({
      sections: {
        F15_pipeline: {
          status: "degraded",
          reasons: ["duplicates_detected=5 — dedup rule leaked"],
        },
      },
    });
    writeArtifacts(dir, prior, latest);
    const { exit, out } = runDrift(dir);
    const named = /NEW_REASON_UNKNOWN/.test(out) && /duplicates_detected/.test(out);
    record("1. new unrecognized reason", "red", exit, [
      `NEW_REASON_UNKNOWN signal fired in log: ${named}`,
    ]);
  } finally { rmScratch(dir); }
}

// -----------------------------------------------------------
// 2. NEW hallucination candidate
// -----------------------------------------------------------
{
  const dir = mkScratch();
  try {
    const prior = baseArtifact();
    const latest = baseArtifact({
      findings: [
        {
          section: "§F17.sector-ideas",
          severity: "HALLUCINATION",
          msg: "theme.sector \"nonesuch\" not in sector-signals.json",
          evidence: { theme: "nonesuch", guard: "apply-sector-ideas.mjs sectorMap check" },
        },
      ],
    });
    writeArtifacts(dir, prior, latest);
    const { exit, out } = runDrift(dir);
    const named = /NEW_HALLUCINATION/.test(out) && /nonesuch/.test(out);
    record("2. new hallucination candidate", "red", exit, [
      `NEW_HALLUCINATION signal fired + item named: ${named}`,
    ]);
  } finally { rmScratch(dir); }
}

// -----------------------------------------------------------
// 3. Standing-tests regressed
// -----------------------------------------------------------
{
  const dir = mkScratch();
  try {
    const prior = baseArtifact(); // D14.ok = true
    const latest = baseArtifact({ sections: { D14: { ok: false } } });
    writeArtifacts(dir, prior, latest);
    const { exit, out } = runDrift(dir);
    const named = /STANDING_TESTS_REGRESSION/.test(out);
    record("3. standing-tests regressed", "red", exit, [
      `STANDING_TESTS_REGRESSION signal fired: ${named}`,
    ]);
  } finally { rmScratch(dir); }
}

// -----------------------------------------------------------
// 4. reported_without_document increased
// -----------------------------------------------------------
{
  const dir = mkScratch();
  try {
    const prior = baseArtifact({
      sections: { F15_pipeline: { reported_without_document: 12 } },
    });
    const latest = baseArtifact({
      sections: { F15_pipeline: { reported_without_document: 25 } },
    });
    writeArtifacts(dir, prior, latest);
    const { exit, out } = runDrift(dir);
    const named = /RWD_INCREASED/.test(out) && /12 → 25/.test(out);
    record("4. reported_without_document increased", "red", exit, [
      `RWD_INCREASED signal fired + delta shown: ${named}`,
    ]);
  } finally { rmScratch(dir); }
}

// -----------------------------------------------------------
// 5. Silent-zero (events_total >0 → 0)
// -----------------------------------------------------------
{
  const dir = mkScratch();
  try {
    const prior = baseArtifact({ sections: { F15_pipeline: { events_total: 21000 } } });
    const latest = baseArtifact({ sections: { F15_pipeline: { events_total: 0 } } });
    writeArtifacts(dir, prior, latest);
    const { exit, out } = runDrift(dir);
    const named = /SILENT_ZERO/.test(out) && /events_total/.test(out);
    record("5. silent-zero events_total >0 → 0", "red", exit, [
      `SILENT_ZERO signal fired + counter named: ${named}`,
    ]);
  } finally { rmScratch(dir); }
}

// -----------------------------------------------------------
// 6. Clean (current == prior) → green
// -----------------------------------------------------------
{
  const dir = mkScratch();
  try {
    const prior = baseArtifact();
    const latest = baseArtifact(); // identical
    writeArtifacts(dir, prior, latest);
    const { exit, out } = runDrift(dir);
    const quiet = /quiet — no drift/.test(out);
    record("6. clean current == prior", "green", exit, [
      `'quiet — no drift' printed: ${quiet}`,
    ]);
  } finally { rmScratch(dir); }
}

// -----------------------------------------------------------
// 7. audit-daily grep-guard — READ-ONLY invariant
//
// Replicates the workflow YAML's exact pipeline:
//   STAGED=$(git diff --cached --name-only | grep -v "^scripts/audits/history/" || true)
//   if [ -n "$STAGED" ]; then exit 1; fi
//
// Uses a scratch git repo — synthetic files, no touch to real repo.
// -----------------------------------------------------------
{
  const dir = mkScratch();
  // Explicit bash — Windows defaults to cmd.exe which doesn't
  // understand $STAGED substitution or the `|| true` pattern.
  // The audit-daily workflow runs on ubuntu-latest, so bash IS
  // the target shell. Testing with the same shell here is honest.
  const runSh = (cmd) =>
    spawnSync(cmd, { shell: "bash", cwd: dir, encoding: "utf-8" });
  try {
    runSh("git init -q");
    runSh("git config user.email test@example.com && git config user.name test");
    fs.mkdirSync(path.join(dir, "scripts/audits/history"), { recursive: true });
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts/audits/history/a.json"), "{}");
    fs.writeFileSync(path.join(dir, "data/leak.json"), "{}"); // <-- stray file
    runSh("git add scripts/audits/history/a.json data/leak.json");
    // Guard command from audit-daily.yml verbatim:
    const guard = runSh(
      'STAGED=$(git diff --cached --name-only | grep -v "^scripts/audits/history/" || true); if [ -n "$STAGED" ]; then echo "OUTSIDE: $STAGED"; exit 1; else exit 0; fi',
    );
    const named = /data\/leak\.json/.test(guard.stdout ?? "");
    record("7. grep-guard fires on stray staged file outside history/", "red", guard.status ?? -1, [
      `stray file named in output: ${named}`,
    ]);
  } finally { rmScratch(dir); }
}

// -----------------------------------------------------------
// Summary
// -----------------------------------------------------------
console.log(`\n=== summary ===`);
console.log(`  PASS=${passCount} · FAIL=${failCount}`);
process.exit(failCount > 0 ? 1 : 0);
