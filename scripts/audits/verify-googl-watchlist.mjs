#!/usr/bin/env node
/**
 * One-off headless-browser verifier for the GOOGL Q2 2026 surprise
 * fix on the deployed watchlist. Loads /, waits for hydration + the
 * live Yahoo bulk fetch, then locates the GOOGL row and reports what
 * surprise-column text renders.
 *
 * Expected AFTER 0bc547dae:
 *   Row should show 'reported · basis mismatch' or 'reported · no est',
 *   NOT '+214.2%' or similar three-digit ratio.
 *
 *   node scripts/audits/verify-googl-watchlist.mjs
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLAYWRIGHT_ENTRY = path.resolve(__dirname, "..", "..", "frontend", "node_modules", "playwright", "index.mjs");
const { chromium } = await import(pathToFileURL(PLAYWRIGHT_ENTRY).href);

const URL = "https://earnings-karlis123.vercel.app/";
const TARGET = "GOOGL";

async function launch() {
  try { return await chromium.launch({ channel: "msedge", headless: true }); }
  catch { return await chromium.launch({ headless: true }); }
}

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
console.log(`loading ${URL} …`);
await page.goto(URL, { waitUntil: "networkidle", timeout: 30_000 });
// Wait a beat for the initial hydration.
await page.waitForTimeout(2000);
// Default filter is "Our portfolio" (14 covered names — no GOOGL).
// Click the S&P 500 tab so GOOGL appears in the row set. The tab is
// rendered as text, not a semantic button — locator by text.
try {
  await page.getByText(/^S&P 500$/, { exact: true }).first().click({ timeout: 5000 });
  console.log(`  clicked filter: S&P 500`);
} catch (e) {
  console.log(`  filter click failed: ${e.message}`);
}
await page.waitForTimeout(5000);
// Progressive scroll so a virtualized list hydrates every G-through-Z row.
for (let s = 0; s <= 4; s++) {
  await page.evaluate((frac) => window.scrollTo(0, document.body.scrollHeight * frac / 4), s);
  await page.waitForTimeout(600);
}

// Grab the whole DOM text and find the GOOGL row's surrounding context.
const rowText = await page.evaluate((target) => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const matches = [];
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent ?? "";
    if (t.includes(target)) {
      let parent = walker.currentNode.parentElement;
      for (let i = 0; i < 6 && parent; i++) parent = parent.parentElement;
      if (parent) matches.push(parent.textContent?.slice(0, 500) ?? "");
    }
  }
  return matches;
}, TARGET);

if (rowText.length === 0) {
  console.log(`  ✗ ${TARGET} not found on the page`);
  // Dump the first 30 tickers actually visible so we know how the
  // page IS labeling rows.
  const dump = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href")).filter(Boolean);
    return {
      title: document.title,
      linkCount: links.length,
      sampleLinks: links.slice(0, 20),
      bodySnippet: (document.body.innerText ?? "").slice(0, 800),
    };
  });
  console.log(`  title:`, dump.title);
  console.log(`  link count:`, dump.linkCount);
  console.log(`  sample links:`, dump.sampleLinks);
  console.log(`  body snippet:\n${dump.bodySnippet}`);
} else {
  for (const [i, txt] of rowText.entries()) {
    console.log(`\n--- match ${i + 1} (first 500 chars of surrounding node) ---`);
    console.log(txt.trim().slice(0, 400));
  }
}

// Also do a whole-page grep for +214 and 'basis mismatch'.
const fullText = await page.evaluate(() => document.body.innerText ?? "");
console.log(`\n=== summary ===`);
console.log(`  page mentions '214': ${/214[.,]?\d?%/.test(fullText)}`);
console.log(`  page mentions 'basis mismatch': ${/basis mismatch/i.test(fullText)}`);

await browser.close();
