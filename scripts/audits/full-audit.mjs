#!/usr/bin/env node
/**
 * /audit — full read-only dashboard audit.
 * Deterministic-first: every finding cites file path + field + value.
 * No writes to data/. Never fixes anything.
 *
 *   node scripts/audits/full-audit.mjs [--out <path>]
 *
 * Output:
 *   - stdout: markdown summary + ranked action list
 *   - file:   scripts/audits/full-audit-<ISO>.json (evidence dump)
 *
 * Sections executed on-disk (matches .claude/commands/audit.md):
 *   §D14 — run test-standing.mjs
 *   §F17 — trust-model reconcile on AI files
 *   §A   — per-ticker completeness (universe)
 *   §B   — provenance/staleness spot-checks
 *   §E   — aggregate file integrity
 *   §F15 — pipeline-report silent-zero
 *   §F18 — git integrity
 *
 * UNVERIFIED (needs live deploy):
 *   §C, §G, §F16 — marked in output, never silently skipped.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const ISO = new Date().toISOString().replace(/[:.]/g, "-");
const outArgIdx = process.argv.indexOf("--out");
const OUT_PATH = outArgIdx >= 0
  ? process.argv[outArgIdx + 1]
  : path.join(__dirname, `full-audit-${ISO}.json`);

const report = {
  schema: "audit-report/v1",
  generatedAt: new Date().toISOString(),
  sections: {},
  findings: [],
  unverified: [],
};

function finding(section, severity, msg, evidence) {
  const row = { section, severity, msg, evidence };
  report.findings.push(row);
  const sev = severity.padEnd(10);
  console.error(`[${sev}] ${section} · ${msg}`);
  if (evidence) console.error(`           evidence: ${JSON.stringify(evidence).slice(0, 300)}`);
}

function unverified(section, reason) {
  report.unverified.push({ section, reason });
  console.error(`[UNVERIFIED] ${section} · ${reason}`);
}

async function readJson(rel) {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf-8"));
  } catch {
    return null;
  }
}

async function readJsonl(rel) {
  try {
    const raw = await fs.readFile(path.join(ROOT, rel), "utf-8");
    const rows = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
    return rows;
  } catch {
    return null;
  }
}

async function main() {
  console.error(`--- /audit · ${report.generatedAt} ---`);

  // ============================================================
  // §D14 — standing tests (verbatim capture)
  // ============================================================
  {
    console.error("\n§D14 · standing tests");
    let out = "";
    let ok = null;
    try {
      out = execSync("node scripts/test-standing.mjs", {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180_000,
      }).toString();
      ok = true;
    } catch (e) {
      out = ((e.stdout ?? "") + "\n" + (e.stderr ?? "")).toString();
      ok = false;
    }
    const tail = out.split("\n").slice(-20).join("\n");
    report.sections.D14 = { ok, tail };
    // extract failed line count
    const failLine = tail.match(/(\d+) test\(s\) failed/);
    if (failLine) {
      finding("§D14", ok ? "PASS" : "FAIL", `standing tests: ${failLine[0]}`, { tail: tail.slice(-800) });
    } else if (ok) {
      finding("§D14", "PASS", "standing tests all green", null);
    } else {
      finding("§D14", "FAIL", "standing tests failed with no counter parse", { tail: tail.slice(-800) });
    }
  }

  // ============================================================
  // §F17 — trust-model reconcile on AI-written files
  // ============================================================
  console.error("\n§F17 · trust-model reconcile");

  const signals = await readJson("data/sector-signals.json");
  const ideas = await readJson("data/sector-ideas.json");
  const narrative = await readJson("data/week-ahead-narrative.json");
  const eventsIdx = await readJson("data/events-index.json");
  const registry = await readJson("data/entity-registry.json");
  const entities = registry?.entities ?? registry ?? [];

  // sector-ideas ↔ sector-signals reconcile
  if (ideas && signals) {
    const sectorMap = new Map(signals.sectors.map((s) => [s.sector, s]));
    let ok = 0, tickerFail = 0, headlineFail = 0, dpFail = 0, sectorFail = 0;
    for (const t of ideas.themes ?? []) {
      const sec = sectorMap.get(t.sector);
      if (!sec) {
        finding("§F17.sector-ideas", "HALLUCINATION", `theme.sector "${t.sector}" not in sector-signals.json`, { theme: t.sector, guard: "apply-sector-ideas.mjs sectorMap check" });
        sectorFail++;
        continue;
      }
      const tickerSet = new Set(sec.tickers ?? []);
      for (const st of t.supportingTickers ?? []) {
        if (!tickerSet.has(st)) {
          finding("§F17.sector-ideas", "HALLUCINATION", `supportingTicker "${st}" not in sector "${t.sector}" tickers[]`, { theme: t.sector, ticker: st, guard: "apply-sector-ideas.mjs sectorTickers check" });
          tickerFail++;
        }
      }
      const headlineIdx = new Map();
      for (const h of sec.recentHeadlines ?? []) headlineIdx.set(h.ticker + "||" + h.headline, h);
      for (const kh of t.keyHeadlines ?? []) {
        const key = (kh.ticker ?? "") + "||" + (kh.headline ?? "");
        if (!headlineIdx.has(key)) {
          finding("§F17.sector-ideas", "HALLUCINATION", `keyHeadline (${kh.ticker}) not in sector "${t.sector}" recentHeadlines`, { theme: t.sector, ticker: kh.ticker, headline: (kh.headline ?? "").slice(0, 80), guard: "apply-sector-ideas.mjs headlineIndex check" });
          headlineFail++;
        }
      }
      // dataPoints echo
      const dp = t.dataPoints ?? {};
      const drift = [];
      if (dp.medianReaction3d !== (sec.medianReaction3d ?? null)) drift.push(`medianReaction3d ai=${dp.medianReaction3d} src=${sec.medianReaction3d}`);
      if (dp.newsCountAll !== (sec.newsCountAll ?? 0)) drift.push(`newsCountAll ai=${dp.newsCountAll} src=${sec.newsCountAll}`);
      if (dp.tickerCount !== (sec.tickerCount ?? 0)) drift.push(`tickerCount ai=${dp.tickerCount} src=${sec.tickerCount}`);
      if (drift.length > 0) {
        finding("§F17.sector-ideas", "DATA_DRIFT", `dataPoints diverge for sector "${t.sector}"`, { drift, guard: "apply-sector-ideas.mjs dataPoints overwrite (should match verbatim)" });
        dpFail++;
      }
      if (!t.thesis || t.thesis.length < 60 || t.thesis.length > 200) {
        finding("§F17.sector-ideas", "GUARD_GAP", `thesis length ${t.thesis?.length ?? 0} out of 60-200 range`, { theme: t.sector, guard: "apply-sector-ideas.mjs thesis range check" });
      }
      if (!t.rationale || t.rationale.length < 200 || t.rationale.length > 600) {
        finding("§F17.sector-ideas", "GUARD_GAP", `rationale length ${t.rationale?.length ?? 0} out of 200-600 range`, { theme: t.sector, guard: "apply-sector-ideas.mjs rationale range check" });
      }
      ok++;
    }
    report.sections.F17_sector_ideas = { themes: ideas.themes?.length ?? 0, ok, sectorFail, tickerFail, headlineFail, dataPointsFail: dpFail };
  } else {
    if (!ideas) unverified("§F17.sector-ideas", "data/sector-ideas.json missing");
    if (!signals) unverified("§F17.sector-ideas", "data/sector-signals.json missing (needed to reconcile ideas)");
  }

  // week-ahead-narrative ↔ events-index reconcile
  if (narrative && eventsIdx) {
    const idxByTicker = new Map((eventsIdx.entries ?? []).map((e) => [e.ticker, e]));
    let ok = 0, bad = 0;
    for (const h of narrative.highlights ?? []) {
      const ent = idxByTicker.get(h.ticker);
      if (!ent) {
        finding("§F17.week-ahead", "HALLUCINATION", `highlight ticker ${h.ticker} not in events-index`, { ticker: h.ticker, guard: "apply-week-ahead.mjs indexByTicker check" });
        bad++;
        continue;
      }
      if (ent.nextScheduled !== h.eventDate) {
        finding("§F17.week-ahead", "DATA_DRIFT", `highlight eventDate ${h.eventDate} != index nextScheduled ${ent.nextScheduled} for ${h.ticker}`, { ticker: h.ticker, guard: "apply-week-ahead.mjs eventDate cross-check" });
        bad++;
        continue;
      }
      ok++;
    }
    report.sections.F17_week_ahead = { highlights: narrative.highlights?.length ?? 0, ok, bad };
  } else {
    if (!narrative) unverified("§F17.week-ahead", "data/week-ahead-narrative.json missing");
  }

  // screens/{blue-ocean,rule-breaker}.json — expected missing until first workflow fire
  for (const fw of ["blue-ocean", "rule-breaker"]) {
    const scr = await readJson(`data/screens/${fw}.json`);
    if (!scr) {
      unverified(`§F17.${fw}`, `data/screens/${fw}.json missing (first workflow fire scheduled Sept 1-2)`);
      continue;
    }
    // Basic guard-gap checks: composite == mean(dimensions), dimensions == 5 entries
    let cards = scr.screens?.length ?? 0, bad = 0;
    for (const c of scr.screens ?? []) {
      if (!Array.isArray(c.dimensions) || c.dimensions.length !== (scr.dimensions?.length ?? -1)) {
        finding(`§F17.${fw}`, "GUARD_GAP", `${c.ticker} dimensions count != schema`, { ticker: c.ticker, guard: `apply-screen.mjs dimensions count check` });
        bad++;
        continue;
      }
      const sum = c.dimensions.reduce((s, d) => s + (d.score ?? 0), 0);
      const mean = sum / c.dimensions.length;
      if (Math.abs(mean - c.compositeScore) > 0.5) {
        finding(`§F17.${fw}`, "DATA_DRIFT", `${c.ticker} compositeScore ${c.compositeScore} != dimensions mean ${mean.toFixed(2)}`, { ticker: c.ticker, guard: `apply-screen.mjs composite math check` });
        bad++;
      }
    }
    report.sections[`F17_${fw}`] = { cards, bad };
  }

  // summaries/*.json — SAMPLE ONLY, full corpus is 1200+ files
  {
    const dir = path.join(ROOT, "data", "summaries");
    let files;
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    const sample = files.slice(0, 10);
    let ok = 0, missingTicker = 0;
    const registryTickers = new Set(entities.map((e) => e.ticker));
    for (const f of sample) {
      const s = await readJson(`data/summaries/${f}`);
      if (!s) continue;
      if (!s.ticker || !registryTickers.has(s.ticker)) {
        finding("§F17.summaries", "GUARD_GAP", `summary ${f} ticker "${s.ticker}" not in registry`, { file: f, ticker: s.ticker, guard: "validate.js summary schema" });
        missingTicker++;
        continue;
      }
      ok++;
    }
    report.sections.F17_summaries = {
      total: files.length,
      sampled: sample.length,
      ok,
      missingTicker,
      note: `sample-only — ${files.length - sample.length} summaries unverified in this pass`,
    };
    unverified("§F17.summaries.full", `only 10 of ${files.length} summaries sampled — full corpus reconciliation is out of scope for the thin first-pass audit`);
  }

  // ============================================================
  // §A per-ticker completeness (universe count only in first pass)
  // ============================================================
  console.error("\n§A · per-ticker completeness");
  if (registry && eventsIdx) {
    const idxByTicker = new Map((eventsIdx.entries ?? []).map((e) => [e.ticker, e]));
    let universe = 0, operating = 0, dev = 0, etf = 0;
    let noSummary = 0, noMetrics = 0, noNextDate = 0, noReactions = 0;
    for (const e of entities) {
      if (e.dormant) continue;
      if (e.securityType === "pre-listing") continue;
      const mem = e.index_membership ?? [];
      if (!e.isCore && !mem.includes("SP500") && !mem.includes("R1000")) continue;
      universe++;
      if (e.securityType === "operating") operating++;
      else if (e.securityType === "developer") dev++;
      else if (e.securityType === "etf") etf++;
      const entry = idxByTicker.get(e.ticker);
      if (!entry) {
        finding("§A.completeness", "FAIL", `${e.ticker} in universe but missing from events-index`, { ticker: e.ticker });
        continue;
      }
      if (e.securityType === "operating") {
        if (!entry.latestMetrics || Object.keys(entry.latestMetrics).length === 0) noMetrics++;
        if (!entry.nextScheduled) noNextDate++;
        const rx = entry.lastEventReactionPoints ?? [];
        if (rx.length === 0) noReactions++;
      }
    }
    report.sections.A_completeness = { universe, operating, developer: dev, etf, noMetrics, noNextDate, noReactions };
    if (noMetrics > 0) finding("§A.completeness", "INFO", `${noMetrics} operating tickers with empty latestMetrics`, null);
    if (noNextDate > 0) finding("§A.completeness", "INFO", `${noNextDate} operating tickers with no nextScheduled (may self-heal)`, null);
  }

  // ============================================================
  // §B provenance / staleness spot-checks — mtime + generatedAt drift
  // ============================================================
  console.error("\n§B · provenance + staleness");
  const dataFiles = [
    ["data/sector-signals.json", 30, "daily"],
    ["data/sector-ideas.json", 24 * 8, "weekly"],
    ["data/correlations.json", 30, "daily"],
    ["data/commodities.json", 30, "daily"],
    ["data/market-pulse.json", 30, "daily"],
    ["data/macro-signals.json", 30, "daily"],
    ["data/week-ahead-narrative.json", 24 * 8, "weekly"],
    ["data/screens/qarv.json", 24 * 30, "on-demand"],
    ["data/events-index.json", 30, "daily"],
  ];
  const now = Date.now();
  for (const [rel, maxHours, cadence] of dataFiles) {
    try {
      const st = await fs.stat(path.join(ROOT, rel));
      const ageH = (now - st.mtimeMs) / 3_600_000;
      if (ageH > maxHours) {
        finding("§B.staleness", "STALE", `${rel} · ${ageH.toFixed(0)}h old (max ${maxHours}h · ${cadence})`, { file: rel, ageHours: ageH.toFixed(0), maxHours });
      }
    } catch {
      finding("§B.staleness", "MISSING", `${rel} not on disk`, { file: rel, cadence });
    }
  }

  // ============================================================
  // §E aggregate file integrity — correlations symmetry, matrix cells
  // ============================================================
  console.error("\n§E · aggregate file integrity");

  const corr = await readJson("data/correlations.json");
  if (corr) {
    const t = corr.tickers ?? [];
    const m = corr.matrix ?? {};
    let asym = 0, nanCells = 0, nullCells = 0, diagBad = 0;
    for (const a of t) {
      if (m[a]?.[a] !== 1) diagBad++;
      for (const b of t) {
        const ab = m[a]?.[b];
        const ba = m[b]?.[a];
        if (ab !== ba) asym++;
        if (typeof ab === "number" && Number.isNaN(ab)) nanCells++;
        if (a !== b && ab === null) nullCells++;
      }
    }
    report.sections.E_correlations = { tickers: t.length, asym, nanCells, nullCells, diagBad };
    if (asym > 0) finding("§E.correlations", "FAIL", `matrix asymmetric in ${asym} cells`, { asym });
    if (nanCells > 0) finding("§E.correlations", "FAIL", `${nanCells} NaN cells`, { nanCells });
    if (diagBad > 0) finding("§E.correlations", "FAIL", `${diagBad} diagonal cells != 1`, { diagBad });
    if (nullCells > 0) finding("§E.correlations", "INFO", `${nullCells} null cells (< minSharedBars threshold — expected for thin listings)`, null);
  } else {
    unverified("§E.correlations", "data/correlations.json missing");
  }

  const commodities = await readJson("data/commodities.json");
  if (commodities) {
    const errored = (commodities.items ?? []).filter((i) => i.error).map((i) => i.symbol);
    report.sections.E_commodities = { items: commodities.items?.length ?? 0, errored };
    if (errored.length > 0) finding("§E.commodities", "INFO", `${errored.length} commodities errored on fetch`, { errored });
  }

  const history = await readJsonl("data/sector-history.jsonl");
  if (history) {
    const byKey = new Map();
    let dupes = 0;
    for (const r of history) {
      const k = r.date + "|" + r.sector;
      if (byKey.has(k)) dupes++;
      byKey.set(k, r);
    }
    const dates = new Set(history.map((r) => r.date));
    report.sections.E_sector_history = { rows: history.length, uniqueDates: dates.size, dupes };
    if (dupes > 0) finding("§E.sector-history", "FAIL", `${dupes} duplicate (date, sector) rows`, { dupes });
  }

  // ============================================================
  // §F15 pipeline-report silent-zero detection
  // ============================================================
  console.error("\n§F15 · pipeline-report self-consistency");
  const pipeline = await readJson("data/pipeline-report.json");
  if (pipeline) {
    report.sections.F15_pipeline = {
      status: pipeline.status,
      reasons: pipeline.reasons ?? [],
      events_total: pipeline.events_total,
      reactions_computed: pipeline.reactions_computed,
      duplicates_detected: pipeline.duplicates_detected,
      // Raw counters — stamp them regardless of whether they crossed
      // the run-pipeline-check thresholds that raise reasons[].
      // detect-drift.mjs needs the raw numbers to catch a metric that
      // grew below the alarm floor (e.g., 12 → 25) without waiting for
      // the reason to fire.
      reported_without_document: pipeline.reported_without_document,
      reported_without_document_structural: pipeline.reported_without_document_structural,
      sp500_complete_pct: pipeline.sp500_complete_pct,
    };
    if (pipeline.status !== "ok") {
      finding("§F15.pipeline", "DEGRADED", `pipeline-report status=${pipeline.status}`, { reasons: pipeline.reasons });
    }
    if (pipeline.events_total === 0) {
      finding("§F15.pipeline", "SILENT_ZERO", `events_total=0 (mechanical layer likely errored)`, null);
    }
  }

  // ============================================================
  // §F18 git integrity — no orphan history, HEAD has ancestry
  // ============================================================
  console.error("\n§F18 · git integrity");
  try {
    const head = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
    // Cross-platform parent check — try HEAD^ directly, catch failure.
    let parent = null;
    try {
      parent = execSync("git rev-parse HEAD~1", {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
    } catch {
      // No parent — root commit or repo issue.
    }
    if (!parent) {
      finding("§F18.git", "FAIL", "HEAD has no parent commit — repo may be corrupted", { head });
    } else {
      report.sections.F18_git = { head, parent, hasAncestry: true };
    }
    // Also check that we're on main
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT }).toString().trim();
    if (branch !== "main") {
      finding("§F18.git", "INFO", `not on main (branch=${branch})`, { branch });
    }
  } catch (e) {
    finding("§F18.git", "FAIL", "git checks failed", { error: e.message });
  }

  // ============================================================
  // §C / §G / §F16 — UNVERIFIED (need live deploy or Actions API)
  // ============================================================
  unverified("§C.source-previews", "requires api/documents/proxy against live deploy");
  unverified("§G.endpoint-health", "requires HTTP sampling against live deploy");
  unverified("§F16.workflow-schedule", "requires GitHub Actions run-history read (auth-gated)");

  // ============================================================
  // Emit JSON + markdown summary
  // ============================================================
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(report, null, 2));
  console.error(`\n✓ wrote ${OUT_PATH}`);

  // ---------- Markdown summary ----------
  const bySev = {};
  for (const f of report.findings) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  const fail = bySev.FAIL ?? 0;
  const hallucinations = bySev.HALLUCINATION ?? 0;
  const drift = bySev.DATA_DRIFT ?? 0;
  const guardGap = bySev.GUARD_GAP ?? 0;
  const stale = bySev.STALE ?? 0;
  const degraded = bySev.DEGRADED ?? 0;

  const md = [];
  md.push("");
  md.push("# /audit summary · " + report.generatedAt.slice(0, 19).replace("T", " "));
  md.push("");
  md.push(`- **PASS** ${bySev.PASS ?? 0} · **FAIL** ${fail} · **HALLUCINATION** ${hallucinations} · **DATA_DRIFT** ${drift} · **GUARD_GAP** ${guardGap} · **STALE** ${stale} · **DEGRADED** ${degraded} · **INFO** ${bySev.INFO ?? 0}`);
  md.push(`- **UNVERIFIED sections**: ${report.unverified.length} (${report.unverified.map((u) => u.section).join(", ")})`);
  md.push("");
  md.push("## Sections executed on-disk");
  for (const [k, v] of Object.entries(report.sections)) {
    md.push(`- **${k}**: ${JSON.stringify(v).slice(0, 200)}`);
  }
  md.push("");

  // Ranked action list
  const selfHeals = [];
  const realBugs = [];
  for (const f of report.findings) {
    if (f.severity === "PASS" || f.severity === "INFO") continue;
    // Self-heals: STALE data (next refresh brings it back), pending horizons, framework-screen missing (first fire Sept 1-2)
    if (f.severity === "STALE" && /monthly/.test(f.evidence?.cadence ?? "")) {
      selfHeals.push(f);
    } else if (f.severity === "DEGRADED" && f.evidence?.reasons?.some((r) => /systemic gap/.test(r))) {
      selfHeals.push(f);
    } else {
      realBugs.push(f);
    }
  }
  md.push("## Ranked action list");
  md.push("");
  md.push("### Real bugs (require intervention)");
  if (realBugs.length === 0) {
    md.push("- **NONE** — no guard gaps, no hallucinations, no silent-zero phases, no matrix corruption, no ancestry breaks.");
  } else {
    for (const f of realBugs) md.push(`- **${f.severity}** · ${f.section} · ${f.msg}`);
  }
  md.push("");
  md.push("### Self-heals next refresh (no action needed)");
  if (selfHeals.length === 0) {
    md.push("- (none this run)");
  } else {
    for (const f of selfHeals) md.push(`- **${f.severity}** · ${f.section} · ${f.msg}`);
  }
  md.push("");
  md.push("## Unverified (need live deploy or Actions API)");
  for (const u of report.unverified) md.push(`- **${u.section}** — ${u.reason}`);
  md.push("");
  md.push(`Evidence dump: \`${path.relative(ROOT, OUT_PATH)}\``);

  console.log(md.join("\n"));

  // Final RESULT line (matches slash-command contract)
  const tickers = report.sections.A_completeness?.universe ?? 0;
  const failures = fail + hallucinations + drift + guardGap;
  console.log("");
  console.log(
    `RESULT: audited (${tickers} tickers · ${failures} failures · ${hallucinations} hallucination candidates · JSON at ${path.relative(ROOT, OUT_PATH)})`,
  );
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
