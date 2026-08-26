#!/usr/bin/env node
/**
 * Headless eyeball of the S&P 500 watchlist tab. Loads /, clicks the
 * S&P 500 filter, forces the virtualized grid to hydrate every row
 * (tall viewport + scroll pass), then dumps the chip text for every
 * mega-cap.
 *
 * Aim: confirm the Y/Y-rev-growth chip renders consistently across
 * the 500 rows and none show the pre-fix +214% / -46% nonsense.
 *
 *   node scripts/audits/eyeball-sp500-tab.mjs
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLAYWRIGHT_ENTRY = path.resolve(__dirname, "..", "..", "frontend", "node_modules", "playwright", "index.mjs");
const { chromium } = await import(pathToFileURL(PLAYWRIGHT_ENTRY).href);

const URL = "https://earnings-karlis123.vercel.app/";

async function launch() {
  try { return await chromium.launch({ channel: "msedge", headless: true }); }
  catch { return await chromium.launch({ headless: true }); }
}

const browser = await launch();
// Tall viewport so more rows materialize per scroll step. Grid rows
// average ~60px; 3000px = ~50 rows visible.
const context = await browser.newContext({ viewport: { width: 1400, height: 3000 } });
const page = await context.newPage();

console.log(`loading ${URL} …`);
await page.goto(URL, { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForTimeout(3000);

// Click the S&P 500 filter tab. The FilterBar wraps all filter tabs
// inside a rounded-button container. Scope the S&P 500 lookup to
// that container to avoid matching a stray badge/chart-label elsewhere.
const clickResult = await page.evaluate(() => {
  const wrappers = Array.from(document.querySelectorAll("div"));
  // Find the wrapper that contains the filter tab strip — its immediate
  // buttons carry the filter labels.
  const filterWrapper = wrappers.find((d) => {
    const btns = Array.from(d.querySelectorAll(":scope > button"));
    if (btns.length < 5) return false;
    const texts = btns.map((b) => b.textContent?.trim() ?? "");
    return texts.some((t) => /Focus|portfolio/i.test(t)) && texts.some((t) => /S&P 500/i.test(t));
  });
  if (!filterWrapper) return { ok: false, reason: "filter wrapper not found" };
  const btn = Array.from(filterWrapper.querySelectorAll(":scope > button")).find((b) => /S&P 500/i.test(b.textContent ?? ""));
  if (!btn) return { ok: false, reason: "S&P 500 button not found in wrapper" };
  btn.click();
  return { ok: true, activeClass: btn.className };
});
console.log("  tab-click:", clickResult);
await page.waitForTimeout(5000);
// Verify the click stuck
const activeTab = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.className?.includes("bg-s3") && /S&P 500|portfolio|Focus|Russell/.test(b.textContent ?? ""));
  return btn?.textContent?.trim() ?? "(none)";
});
console.log(`  active tab after click: "${activeTab}"`);

// Progressive scroll to bottom to force virtualized rows to hydrate,
// then walk back top-to-bottom with pauses, accumulating rows as
// we go. Row buffers dispose after leaving the viewport in some
// libraries, so we HAVE to scan mid-scroll rather than at the end.
const total = await page.evaluate(() => document.body.scrollHeight);
console.log(`  page height after tab click: ${total}px`);
// Accumulate rows across the scroll pass.
const accumulated = new Map();
const step = 800; // slightly less than viewport (3000px) to keep some overlap
for (let y = 0; y <= total; y += step) {
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  await page.waitForTimeout(200);
  const visibleRows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="row"]')).map((r) =>
      (r.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    );
  });
  for (const t of visibleRows) {
    const m = t.match(/\b([A-Z0-9]{1,7})\s+(US|CN|LN|HK|MM|JP|GR|FP|SW|BZ|SJ|AU|SS|NE|IJ|IS|IN|TB|VN|KS|C1|BK|MC|PA|MI|MK|AT|SM|TO|NA|CH|IB|IX|BB|AS)\b/);
    if (m) accumulated.set(m[0], t);
  }
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(500);

// Use rows accumulated during the scroll pass.
const rows = [...accumulated.entries()].map(([ticker, rowText]) => ({ ticker, rowText }));
console.log(`  (accumulated ${rows.length} unique rows across ${Math.ceil(total/step)} scroll steps)`);

console.log(`\ntotal S&P 500 rows rendered: ${rows.length}`);
if (rows.length === 0) {
  const debug = await page.evaluate(() => ({
    hasSp500Header: /S&P 500|Russell|1022 sector-universe/i.test(document.body.innerText ?? ""),
    activeTab: (Array.from(document.querySelectorAll("button")).find((b) => b.className?.includes("bg-s3") && /S&P 500|portfolio|Focus|Russell/i.test(b.textContent ?? ""))?.textContent ?? "").trim(),
    bodyHead: (document.body.innerText ?? "").slice(0, 400).replace(/\s+/g, " "),
  }));
  console.log("  debug — active tab:", debug.activeTab || "(none highlighted)");
  console.log("  debug — body head:", debug.bodyHead);
}
console.log("");

// Also — scroll each mega-cap into view individually via its ticker
// text and grab its row snippet. This bypasses the virtualization
// eviction problem.
const megaCaps = ["GOOGL US", "NVDA US", "AAPL US", "MSFT US", "META US", "TSLA US", "AMZN US", "JPM US", "V US", "WMT US", "SJM US", "SBUX US", "DIS US", "CRWD US"];
const megaSightings = {};
for (const t of megaCaps) {
  try {
    // Find the row by ticker text and scroll it into view. Multiple rows
    // may match (foreign listings), pin to the one under S&P 500 filter.
    const locator = page.locator(`[role="row"]:has-text("${t}")`).first();
    if ((await locator.count()) > 0) {
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
      await page.waitForTimeout(200);
      const txt = await locator.innerText().catch(() => "");
      const flat = txt.replace(/\s+/g, " ").trim().slice(0, 300);
      const m = flat.match(/([+-]?\d+\.\d+)% y\/y rev|Beat\s*[+-]?\d+\.\d+%|Miss\s*-?\d+\.\d+%|basis mismatch|reported\s*[·.]?\s*no est|not reported/);
      megaSightings[t] = m ? m[0] : `(chip not in snippet: ${flat.slice(0, 100)}…)`;
    } else {
      megaSightings[t] = "(row locator returned 0)";
    }
  } catch (e) { megaSightings[t] = `error: ${e.message.slice(0, 80)}`; }
}

// Extract chip text — look for the y/y rev pattern or fallback labels
const chipPatterns = [
  { name: "y/y rev", re: /([+-]?\d+\.\d+)% y\/y rev/ },
  { name: "beat", re: /Beat\s*[+-]?\d+\.\d+%/ },
  { name: "miss", re: /Miss\s*-?\d+\.\d+%/ },
  { name: "basis mismatch", re: /basis mismatch/ },
  { name: "no est", re: /reported\s*[·.]?\s*no est/ },
  { name: "not reported", re: /\bnot reported\b/ },
];

const chipCount = { "y/y rev": 0, beat: 0, miss: 0, "basis mismatch": 0, "no est": 0, "not reported": 0 };

for (const r of rows) {
  const t = r.rowText ?? "";
  for (const p of chipPatterns) if (p.re.test(t)) { chipCount[p.name]++; break; }
}

console.log("=== chip pattern tally across all rendered rows ===");
for (const [name, n] of Object.entries(chipCount)) {
  console.log(`  ${String(n).padStart(4)}  ${name}`);
}

console.log("\n=== mega-cap chips ===");
for (const t of megaCaps) {
  console.log(`  ${t.padEnd(12)} · ${megaSightings[t] ?? "NOT RENDERED"}`);
}

// Sanity check — no huge deltas
const nonsensePct = rows.filter((r) => {
  const m = (r.rowText ?? "").match(/([+-]?\d+\.\d+)% y\/y rev/);
  if (!m) return false;
  const v = parseFloat(m[1]);
  return Math.abs(v) > 200;
});
console.log(`\n=== rows with |Y/Y| > 200% (potentially still-wrong values) ===`);
console.log(`  count: ${nonsensePct.length}`);
if (nonsensePct.length > 0 && nonsensePct.length <= 15) {
  for (const r of nonsensePct) {
    const m = (r.rowText ?? "").match(/([+-]?\d+\.\d+)% y\/y rev/);
    console.log(`  ${r.ticker.padEnd(12)} · ${m ? m[0] : "?"}`);
  }
}

await browser.close();
