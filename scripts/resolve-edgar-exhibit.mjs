#!/usr/bin/env node
/**
 * Resolve an EDGAR 8-K filing URL (or accession) to its Exhibit 99.1
 * press-release URL. Companies file the 8-K cover as one document
 * (e.g. `aapl-20260730.htm`) and the actual press release as a
 * separate exhibit (e.g. `a8-kex991q3202606272026.htm`). /earnings
 * needs the exhibit for narrative extraction — burning fetch budget
 * on the cover document, then having Claude eyeball the accession
 * folder and construct the exhibit URL from scratch, has repeatedly
 * exhausted the 3-fetch budget on big issuers with unusual filenames.
 *
 * This script does the mechanical resolution in one call: given the
 * 8-K URL, it fetches the folder index once (uses fetch-edgar.mjs's
 * fair-access convention) and prints the resolved exhibit URL to
 * stdout. Callers can then fetch-edgar the exhibit directly.
 *
 *   node scripts/resolve-edgar-exhibit.mjs <8-K-url-or-accession>
 *
 * Accepts either:
 *   - A full URL like https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/aapl-20260730.htm
 *   - A folder URL like https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/
 *   - A raw accession string like "0000320193-26-000018" WITH --cik <CIK>
 *
 * Stdout: one line, the resolved exhibit URL.
 * Exit 0 on success, 3 if no ex99 exhibit found, 4 on fetch error.
 */

import { URL as NodeURL } from "node:url";

const HARDCODED_FALLBACK_EMAIL = "your-email@example.com";
const MIN_SPACING_MS = 1100;

function usage(msg) {
  if (msg) process.stderr.write(`resolve-edgar-exhibit: ${msg}\n`);
  process.stderr.write(
    `usage: node scripts/resolve-edgar-exhibit.mjs <8-K-url>\n` +
      `       node scripts/resolve-edgar-exhibit.mjs <accession> --cik <CIK>\n`,
  );
  process.exit(2);
}

function folderUrlFrom(input, cik) {
  if (/^https?:\/\/(www\.)?sec\.gov\//.test(input)) {
    const u = new NodeURL(input);
    // Ensure trailing slash so we hit the folder listing, not a doc.
    // Path shape: /Archives/edgar/data/<CIK>/<accession-nodashes>/<file>
    // Strip trailing filename (if any) then normalize trailing slash.
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length && parts[parts.length - 1].includes(".")) {
      parts.pop();
    }
    u.pathname = "/" + parts.join("/") + "/";
    return u.toString();
  }
  // Raw accession string.
  if (!cik) usage("--cik <CIK> required when passing a raw accession");
  const acc = input.replace(/-/g, "");
  const cikPadded = String(cik).replace(/^CIK/i, "").replace(/^0+/, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikPadded}/${acc}/`;
}

async function respectRateLimit() {
  // In-process only — this script is short-lived. The fair-access
  // policy is one-req-per-sec across the whole session, but the
  // caller runs fetch-edgar.mjs between our calls and that script
  // already has a filesystem lockfile serialising against us.
  await new Promise((r) => setTimeout(r, MIN_SPACING_MS));
}

async function fetchFolder(url) {
  const email = process.env.EDGAR_CONTACT_EMAIL || HARDCODED_FALLBACK_EMAIL;
  const ua = `BluOr earnings dashboard ${email}`;
  await respectRateLimit();
  const r = await fetch(url, {
    headers: { "User-Agent": ua, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    process.stderr.write(
      `resolve-edgar-exhibit: folder fetch ${r.status} ${r.statusText}\n  ${url}\n`,
    );
    process.exit(4);
  }
  return r.text();
}

// Rank candidates by how likely they are to be the primary press
// release exhibit. Higher score wins.
function scoreExhibit(filename) {
  const lower = filename.toLowerCase();
  // Match core EX-99.1 patterns first — Apple's `a8-kex991q3202606272026.htm`,
  // ABBV's `ex-991_earnings...`, generic `ex991.htm` / `ex-99-1.htm`, etc.
  if (/ex[-_]?99[-_]?1(\D|$)/i.test(lower)) return 100;
  if (/ex[-_]?991(\D|$)/i.test(lower)) return 100;
  // EDGAR's "d"-as-decimal-point convention (Donnelley/Merrill
  // filers): `ex99d1.htm` literally encodes "ex99.1" since old
  // EDGAR filenames couldn't carry a second dot.
  if (/ex[-_]?99d1(\D|$)/i.test(lower)) return 100;
  // Cover common looser patterns (some filers use `exhibit991` or
  // `pressrelease*`).
  if (/exhibit[-_]?99[-_]?1/i.test(lower)) return 90;
  if (/press[-_]?release/i.test(lower)) return 80;
  // Second-priority: any ex-99.2 / ex-99.3 (some filers put earnings
  // slides in .2 and the release in .1; we still return .1 candidates
  // above via the higher score).
  if (/ex[-_]?99[-_]?[2-9](\D|$)/i.test(lower)) return 50;
  if (/ex[-_]?99d[2-9](\D|$)/i.test(lower)) return 50;
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage("missing input");
  let input = args[0];
  let cik = null;
  const cikIdx = args.indexOf("--cik");
  if (cikIdx >= 0) cik = args[cikIdx + 1];

  const folderUrl = folderUrlFrom(input, cik);
  const html = await fetchFolder(folderUrl);

  // Parse HTML for links to .htm files in the folder. Two shapes:
  //   1. Directory-listing style (SEC's "Filing Documents" page):
  //      <a href="aapl-20260730.htm">aapl-20260730.htm</a>
  //   2. Folder-index page with a full <table> of exhibits.
  const hrefRegex = /href=["']([^"'>]+\.(?:htm|html))["']/gi;
  const found = new Set();
  let m;
  while ((m = hrefRegex.exec(html))) {
    const href = m[1];
    // Skip parent-directory links and index redirects.
    if (href.startsWith("../") || href.startsWith("#")) continue;
    if (/^0000/.test(href.split("/").pop())) continue; // accession-header docs
    if (/index\.json$|Financial_Report\.xlsx$/i.test(href)) continue;
    // Resolve relative to the folder URL.
    const abs = new NodeURL(href, folderUrl).toString();
    // Only keep documents inside the same accession folder.
    if (!abs.startsWith(folderUrl)) continue;
    found.add(abs);
  }

  const ranked = [...found]
    .map((url) => ({ url, score: scoreExhibit(url.split("/").pop() ?? "") }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    process.stderr.write(
      `resolve-edgar-exhibit: no EX-99* exhibit found in ${folderUrl}\n`,
    );
    if (found.size > 0) {
      process.stderr.write(`  candidates found: ${found.size}\n`);
      for (const url of [...found].slice(0, 8)) {
        process.stderr.write(`    ${url.split("/").pop()}\n`);
      }
    }
    process.exit(3);
  }

  process.stdout.write(ranked[0].url + "\n");
  process.stderr.write(
    `resolve-edgar-exhibit: chose ${ranked[0].url.split("/").pop()} (score ${ranked[0].score})\n`,
  );
}

main().catch((e) => {
  process.stderr.write(
    `resolve-edgar-exhibit: unhandled — ${e.stack ?? e.message ?? e}\n`,
  );
  process.exit(4);
});
