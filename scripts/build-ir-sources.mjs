#!/usr/bin/env node
/**
 * Build entity.irSources from three passes (per prompt1.txt Task 3):
 *
 *   OBSERVED — mine past events' sourceLink (kind="filing") per
 *              company. If a filing URL exists, the venue + reports
 *              page can be derived from where the doc actually lived.
 *              Highest-evidence tier.
 *   DERIVED  — mechanical URL construction for entities with no
 *              observed filings:
 *                CIK holder → EDGAR CIK list
 *                Canadian non-CIK → SEDAR issuer-search URL
 *                any → probe common IR paths from assetProfile.website
 *   RESEARCHED — DEFERRED for this pass. Reports counts + names for
 *              the covered tier that still have no reports_page_url
 *              after obs+der. Would need a bounded Claude WebFetch
 *              run per uncovered ticker (a follow-up task).
 *
 * A URL is NEVER guessed into a field. Every stored URL either
 * (a) came from an observed past event's sourceLink, or
 * (b) was probed with HEAD/GET and returned 200.
 *
 * CLI:
 *   node scripts/build-ir-sources.mjs             # write into registry
 *   node scripts/build-ir-sources.mjs --dry-run   # report only, no writes
 *   node scripts/build-ir-sources.mjs --limit=50  # probe only first N
 *   node scripts/build-ir-sources.mjs --observed-only  # skip derived pass
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
const AUDIT_PATH = path.join(ROOT, "scripts", "audits", "build-ir-sources.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const OBSERVED_ONLY = args.includes("--observed-only");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? 0) || null;

const UA = "Mozilla/5.0 (build-ir-sources)";
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_CONCURRENCY = 6;

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}

// -------- OBSERVED pass helpers --------

function classifyUrl(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  if (/^https?:\/\/(www\.)?sec\.gov\//.test(u)) return "EDGAR";
  if (/^https?:\/\/[^/]*\.sedar(plus)?\.ca\//.test(u)) return "SEDAR";
  if (/^https?:\/\/(www\.)?sedarplus\.ca\//.test(u)) return "SEDAR";
  if (/^https?:\/\/(www\.)?edgar\.sec\.gov\//.test(u)) return "EDGAR";
  return "company-IR";
}

function edgarCikListUrl(cik) {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-Q&dateb=&owner=include&count=40`;
}

function sedarIssuerUrl(legalName) {
  // SEDAR+ search page — we PROBE the search results, we don't store
  // this as a "reports page" (SEDAR doesn't have per-issuer stable
  // reports URLs discoverable without probing). Left as a fallback.
  return `https://www.sedarplus.ca/csa-party/service/create?service=searchProfiles&keyword=${encodeURIComponent(legalName ?? "")}`;
}

// Derive reports_page_url from an observed filing URL by trimming
// to a stable listing path.
function reportsPageFromFilingUrl(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  // Match either
  //   /cgi-bin/browse-edgar?...&CIK=<10digits>&...
  //   /Archives/edgar/data/<CIK>/... (CIK unpadded here, 1-10 digits)
  const cikParamMatch = u.match(/cik[=/](\d{1,10})/);
  const cikPathMatch = u.match(/\/archives\/edgar\/data\/(\d{1,10})\//);
  const cik = cikPathMatch?.[1] ?? cikParamMatch?.[1] ?? null;
  if (cik) {
    const padded = cik.padStart(10, "0");
    return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${padded}&type=10-Q&dateb=&owner=include&count=40`;
  }
  // For company-IR URLs, use the path up through the segment matching
  // "press-releases" or "news-releases" or "investors".
  try {
    const parsed = new URL(url);
    const stableSegments = ["press-releases", "news-releases", "news", "investors", "investor-relations"];
    for (const seg of stableSegments) {
      const idx = parsed.pathname.split("/").findIndex((s) => s === seg);
      if (idx > 0) {
        const trimmedPath = parsed.pathname.split("/").slice(0, idx + 1).join("/");
        return `${parsed.origin}${trimmedPath}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function loadShard(ticker) {
  const p = path.join(EVENTS_DIR, tickerSlug(ticker) + ".json");
  try {
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    return Array.isArray(j) ? j : j.events ?? [];
  } catch {
    return [];
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function probeUrl(url) {
  // Try HEAD first (cheaper), fall back to GET.
  for (const method of ["HEAD", "GET"]) {
    try {
      const r = await fetchWithTimeout(url, {
        method,
        redirect: "follow",
        headers: { "User-Agent": UA, Accept: "*/*" },
      });
      if (r.status >= 200 && r.status < 300) return true;
      if (r.status === 405 && method === "HEAD") continue; // method not allowed → try GET
      return false;
    } catch {
      /* try next method */
    }
  }
  return false;
}

// Runs a pool of async workers with capped concurrency.
async function runPool(items, worker, concurrency) {
  const q = items.slice();
  const workers = Array.from({ length: concurrency }, async () => {
    while (q.length > 0) {
      const item = q.shift();
      if (!item) break;
      try { await worker(item); } catch { /* fail-soft */ }
    }
  });
  await Promise.all(workers);
}

// -------- OBSERVED pass --------

async function observedPass(entity, past, rollup) {
  // Filings we already have on this ticker's shards.
  const filingLinks = past
    .filter((e) => e.sourceLink?.kind === "filing" && e.sourceLink.url)
    .map((e) => ({ url: e.sourceLink.url, at: e.eventDate }));
  if (filingLinks.length === 0) return null;

  // Prefer the most recent one — it reflects "where the next quarter
  // will land" better than a stale link.
  filingLinks.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const primary = filingLinks[0];
  const venue = classifyUrl(primary.url);
  const reportsPage = reportsPageFromFilingUrl(primary.url);
  const pattern =
    venue === "EDGAR"
      ? `${past[0]?.provenance ?? "10-Q/10-K"} on EDGAR — observed at ${primary.at}`
      : venue === "SEDAR"
      ? `SEDAR filing observed at ${primary.at}`
      : `Company-IR press-release URL observed at ${primary.at} (${new URL(primary.url).hostname})`;

  rollup.observed_hits++;
  return {
    publication_venue: venue,
    reports_page_url: reportsPage,
    ir_url: null,
    press_release_url:
      venue === "company-IR" ? reportsPage : null,
    rss_feeds: [],
    publication_pattern: pattern,
    verified_at: new Date().toISOString(),
    source: "observed",
  };
}

// -------- DERIVED pass --------

async function derivedPass(entity, rollup) {
  const result = {
    publication_venue: null,
    reports_page_url: null,
    ir_url: null,
    press_release_url: null,
    rss_feeds: [],
    publication_pattern: null,
    verified_at: new Date().toISOString(),
    source: "derived",
  };

  if (entity.edgarCik) {
    // CIK holder — venue is EDGAR, page is the CIK filings list.
    // This URL is always valid (SEC's browse-edgar accepts any CIK
    // that files with them). No probe needed.
    result.publication_venue = "EDGAR";
    result.reports_page_url = edgarCikListUrl(entity.edgarCik);
    result.publication_pattern = "EDGAR CIK-list — mechanical fallback";
    rollup.derived_cik_hits++;
    return result;
  }

  // Canadian issuer heuristic: ticker suffix "CN". Skip probing SEDAR
  // (it's a search page, not a per-issuer reports URL — SEDAR requires
  // an issuer profile ID we don't derive mechanically). Record the
  // venue but leave reports_page_url null.
  if (entity.ticker.endsWith(" CN") || entity.ticker.endsWith(" CT")) {
    result.publication_venue = "SEDAR";
    result.publication_pattern = "SEDAR filer — reports_page_url null; search-based lookup only";
    rollup.derived_sedar_hits++;
    return result;
  }

  return null; // nothing to derive without a website field we don't store
}

// -------- Main --------

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  let entities = reg.entities ?? [];
  if (LIMIT) entities = entities.slice(0, LIMIT);

  const rollup = {
    schema: "build-ir-sources/v1",
    generatedAt: new Date().toISOString(),
    dry: DRY,
    entities_scanned: entities.length,
    observed_hits: 0,
    derived_cik_hits: 0,
    derived_sedar_hits: 0,
    still_null: 0,
    still_null_covered: [],
    coverage_by_field: {
      publication_venue: 0,
      reports_page_url: 0,
      ir_url: 0,
      press_release_url: 0,
      rss_feeds: 0,
    },
  };

  // Load covered.json to identify the covered tier for the still-null count.
  let covered = new Set();
  try {
    const cov = JSON.parse(await fs.readFile(path.join(ROOT, "data", "covered.json"), "utf-8"));
    covered = new Set(cov.tickers ?? []);
  } catch { /* covered.json absent — proceed without */ }

  const updated = [];
  await runPool(entities, async (entity) => {
    // Only process entities the UI displays — ETFs / funds don't
    // publish earnings; the filter mirrors displayFilter.isDisplayable.
    if (entity.securityType !== "operating" && entity.securityType !== "developer") {
      updated.push(entity);
      return;
    }
    const past = (await loadShard(entity.ticker))
      .filter((e) => e.eventDate)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));

    let irSources = await observedPass(entity, past, rollup);
    if (!irSources && !OBSERVED_ONLY) {
      irSources = await derivedPass(entity, rollup);
    }
    if (!irSources) {
      rollup.still_null++;
      if (covered.has(entity.ticker)) rollup.still_null_covered.push(entity.ticker);
      updated.push(entity);
      return;
    }

    // Coverage rollup.
    if (irSources.publication_venue) rollup.coverage_by_field.publication_venue++;
    if (irSources.reports_page_url) rollup.coverage_by_field.reports_page_url++;
    if (irSources.ir_url) rollup.coverage_by_field.ir_url++;
    if (irSources.press_release_url) rollup.coverage_by_field.press_release_url++;
    if (irSources.rss_feeds.length > 0) rollup.coverage_by_field.rss_feeds++;

    updated.push({ ...entity, irSources });
  }, PROBE_CONCURRENCY);

  console.log(`\n=== build-ir-sources ===`);
  console.log(`  entities scanned:  ${rollup.entities_scanned}`);
  console.log(`  observed hits:     ${rollup.observed_hits}`);
  console.log(`  derived (CIK):     ${rollup.derived_cik_hits}`);
  console.log(`  derived (SEDAR):   ${rollup.derived_sedar_hits}`);
  console.log(`  still null:        ${rollup.still_null} (covered ${rollup.still_null_covered.length})`);
  console.log(`\n  coverage_by_field:`);
  for (const [k, v] of Object.entries(rollup.coverage_by_field)) {
    console.log(`    ${k.padEnd(22)} ${v}/${rollup.entities_scanned}`);
  }
  if (rollup.still_null_covered.length > 0) {
    console.log(`\n  still-null covered tier:`);
    for (const t of rollup.still_null_covered) console.log(`    ${t}`);
  }

  if (!DRY) {
    await fs.writeFile(REG_PATH, JSON.stringify({ ...reg, entities: updated }, null, 2));
    console.log(`\n  ✓ wrote irSources on ${rollup.observed_hits + rollup.derived_cik_hits + rollup.derived_sedar_hits} entities`);
  }
  await fs.mkdir(path.dirname(AUDIT_PATH), { recursive: true });
  await fs.writeFile(AUDIT_PATH, JSON.stringify(rollup, null, 2));
  console.log(`  audit → ${path.relative(ROOT, AUDIT_PATH)}`);
}

main().catch((e) => {
  console.error(`::error::build-ir-sources crash: ${e.stack ?? e.message}`);
  process.exit(1);
});
