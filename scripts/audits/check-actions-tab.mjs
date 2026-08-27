#!/usr/bin/env node
/**
 * Scrape the GitHub Actions tab for our repo. Public repos expose
 * their Actions history without auth. Fetch via Playwright so JS
 * hydrates the run list, then dump each workflow's most recent runs.
 *
 *   node scripts/audits/check-actions-tab.mjs
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLAYWRIGHT_ENTRY = path.resolve(__dirname, "..", "..", "frontend", "node_modules", "playwright", "index.mjs");
const { chromium } = await import(pathToFileURL(PLAYWRIGHT_ENTRY).href);

const WORKFLOWS = [
  { name: "refresh-data", file: "refresh-data.yml" },
  { name: "claude-summarize", file: "claude-summarize.yml" },
  { name: "sector-ideas", file: "sector-ideas.yml" },
  { name: "audit-daily", file: "audit-daily.yml" },
  { name: "week-ahead", file: "week-ahead.yml" },
];

async function launch() {
  try { return await chromium.launch({ channel: "msedge", headless: true }); }
  catch { return await chromium.launch({ headless: true }); }
}

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

for (const wf of WORKFLOWS) {
  const url = `https://github.com/Karlis321/earnings/actions/workflows/${wf.file}`;
  console.log(`\n=== ${wf.name} ===`);
  console.log(`  ${url}`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);
    // Try to grab the run list. Runs are usually in a <div> with data-testid or role=list.
    const runs = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("a[href*='/actions/runs/']"));
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        const href = r.getAttribute("href") ?? "";
        if (seen.has(href)) continue;
        seen.add(href);
        // Walk up to find the row's status text
        let el = r;
        let ancestorText = "";
        for (let i = 0; i < 6 && el.parentElement; i++) {
          ancestorText = (el.parentElement.textContent ?? "").trim().replace(/\s+/g, " ");
          if (ancestorText.length > 30 && ancestorText.length < 400) break;
          el = el.parentElement;
        }
        out.push({ href: href.split("/").pop(), snippet: ancestorText.slice(0, 200) });
        if (out.length >= 3) break;
      }
      return out;
    });
    if (runs.length === 0) console.log("  no runs visible on this workflow's page");
    else for (const r of runs) console.log(`    #${r.href} · ${r.snippet}`);
  } catch (e) {
    console.log(`  ✗ load error: ${e.message}`);
  }
}

await browser.close();
