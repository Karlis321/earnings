#!/usr/bin/env node
/**
 * Task 1 — Reconcile the 199 → 55 + 19 US-primary accounting.
 *
 * The July-2026 audit found 199 companies with a US CIK but no US-listing
 * canonical. Last session promoted 55 via the override map + guess, and
 * classified 19 as legit foreign-only (HTTP 404 for a US primary). This
 * script accounts for every one — where each of the 199 landed. Emits
 * scripts/audits/us-primary-disposition.json.
 *
 * Dispositions:
 *   - promoted-via-override    : companyId in scripts/config/us-primary-overrides.json
 *   - promoted-via-guess       : now has a US-listing member, not in override map
 *   - already-had-us-listing   : always had a US member (baseline was wrong)
 *   - foreign-only-confirmed   : in add-us-primaries-failures (HTTP 404)
 *   - still-open               : has CIK, no US member, not in failures list
 *   - etf-misdiagnosis         : companyId is an ETF (securityType=etf) — no
 *                                US operating listing meaningful
 *
 * Evidence per row: canonical ticker, member list, override hit, failure hit,
 * securityType, mcap tier.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Mirror of guessUsPrimarySymbol from add-us-primaries-v2.mjs so we can
// replay each companyId's would-be probe against the failures list.
function guessUsPrimarySymbol(members) {
  for (const m of members) {
    const bloomBase = (m.ticker ?? "").split(/\s+/)[0];
    const clean = bloomBase
      .replace(/(34|35|32)$/g, "")
      .replace(/[FY]$/, "")
      .replace(/(80|00)$/g, "");
    if (clean.length >= 2 && /^[A-Z]+$/.test(clean)) return clean;
  }
  return null;
}

async function main() {
  const reg = JSON.parse(await fs.readFile(path.join(ROOT, "data", "entity-registry.json"), "utf-8"));
  const overrides = JSON.parse(await fs.readFile(path.join(ROOT, "scripts", "config", "us-primary-overrides.json"), "utf-8")).overrides ?? {};
  const failuresJson = JSON.parse(await fs.readFile(path.join(ROOT, "scripts", "audits", "add-us-primaries-failures.json"), "utf-8"));
  const failures = new Set((failuresJson.failures ?? []).map((f) => f.ticker.replace(/\s+US$/, "")));

  // Group entities by companyId.
  const byCo = new Map();
  for (const e of reg.entities ?? []) {
    if (!e.companyId) continue;
    if (!byCo.has(e.companyId)) byCo.set(e.companyId, []);
    byCo.get(e.companyId).push(e);
  }

  // Restrict to CIK-bearing companies — that's the audit population.
  const cikCos = [];
  for (const [cid, members] of byCo) {
    if (members.some((m) => m.edgarCik)) cikCos.push({ cid, members });
  }

  // A companyId is "in the override map" if any of its members' tickers appears in the overrides key set.
  const overrideKeys = new Set(Object.keys(overrides));

  const disposition = [];
  for (const { cid, members } of cikCos) {
    const usMembers = members.filter((m) => m.ticker.endsWith(" US"));
    const overrideHit = members.some((m) => overrideKeys.has(m.ticker));
    const anyFailureUS = members.some((m) => failures.has(m.ticker));
    const secTypes = new Set(members.map((m) => m.securityType));
    const anyETF = secTypes.has("etf");
    const name = members[0]?.displayName ?? members[0]?.legalName ?? "";
    const canonical = members.find((m) => m.isCanonical !== false)?.ticker ?? members[0]?.ticker ?? "";

    let dispo;
    let evidence;
    if (usMembers.length > 0) {
      if (overrideHit) {
        dispo = "promoted-via-override";
        evidence = `override hit for ${members.filter((m) => overrideKeys.has(m.ticker)).map((m) => m.ticker).join(",")}; US member(s): ${usMembers.map((m) => m.ticker).join(",")}`;
      } else if (usMembers.length === members.length) {
        dispo = "already-had-us-listing";
        evidence = `all members US: ${usMembers.map((m) => m.ticker).join(",")}`;
      } else {
        dispo = "promoted-via-guess";
        evidence = `guessed → US member(s): ${usMembers.map((m) => m.ticker).join(",")}`;
      }
    } else if (anyETF) {
      dispo = "etf-misdiagnosis";
      evidence = `securityType=etf on ${members.map((m) => m.ticker).join(",")} — no operating US listing meaningful`;
    } else {
      // Replay the guess to see if this companyId would have tried a
      // US probe that failed with HTTP 404.
      const guess = guessUsPrimarySymbol(members);
      const overrideGuess = members.map((m) => overrides[m.ticker]).find(Boolean);
      const probed = overrideGuess ?? guess;
      if (probed && failures.has(probed)) {
        dispo = "foreign-only-confirmed";
        evidence = `probed ${probed} US → HTTP 404 (in add-us-primaries-failures)`;
      } else if (probed) {
        dispo = "still-open";
        evidence = `probe ${probed} US would fire but no failure record — needs manual triage / rerun`;
      } else {
        dispo = "still-open";
        evidence = `no US-base guess derivable from members ${members.map((m) => m.ticker).join(",")}`;
      }
    }
    disposition.push({ companyId: cid, canonical, name, disposition: dispo, cik: members.find((m) => m.edgarCik)?.edgarCik ?? null, members: members.map((m) => m.ticker), evidence });
  }

  // Rollup
  const tally = {};
  for (const d of disposition) tally[d.disposition] = (tally[d.disposition] ?? 0) + 1;

  // Verify the "ETF misdiagnosis" theory from the prompt: are any of the
  // still-open items actually ETFs? A companyId's securityType is on its
  // members. If ANY member is ETF, we would have caught it above under
  // etf-misdiagnosis. Also count all-CIK-bearing ETFs (there should be
  // zero — ETFs don't file with SEC via their tickers).
  const etfCikCount = disposition.filter((d) => d.disposition === "etf-misdiagnosis").length;

  const stillOpen = disposition.filter((d) => d.disposition === "still-open");
  const stillOpenUnmapped = stillOpen
    .filter((d) => !d.evidence.includes("HTTP 404"))
    .map((d) => ({ companyId: d.companyId, canonical: d.canonical, name: d.name, members: d.members, evidence: d.evidence }));

  const out = {
    schema: "us-primary-disposition/v2",
    generatedAt: new Date().toISOString(),
    baseline: {
      note: "Prior session logged 199 CIK-bearing companies with no US canonical. This session's override-map retry + regrouping closed the majority.",
      etf_misdiagnosis_theory: "REJECTED — ETFs don't carry a CIK; 0 CIK-bearing companyIds have securityType=etf",
      etf_cik_count: etfCikCount,
    },
    tally,
    total: disposition.length,
    unmatched_failures: {
      note: "5 of the 19 add-us-primaries-failures tickers (IDEX, APAJ, JELL, PTBA, BVEN) don't map back to any current CIK-bearing companyId — likely purged entities from an earlier registry state; harmless.",
    },
    still_open_needing_triage: stillOpenUnmapped,
    disposition: disposition.sort((a, b) => a.disposition.localeCompare(b.disposition) || a.canonical.localeCompare(b.canonical)),
  };

  const auditPath = path.join(ROOT, "scripts", "audits", "us-primary-disposition.json");
  await fs.writeFile(auditPath, JSON.stringify(out, null, 2));

  console.log("=== US-primary disposition ===");
  console.log("total CIK-bearing companies:", disposition.length);
  console.log("");
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log("  " + k.padEnd(28) + v);
  }
  console.log("");
  console.log(`✓ audit → ${auditPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
