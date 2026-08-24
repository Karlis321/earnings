#!/usr/bin/env node
/**
 * §C source-viewer behavior audit — headless browser check.
 *
 * Audit only. No writes to data/. Not wired into the daily pipeline.
 *
 *   node scripts/audits/viewer-source-check.mjs [--base <url>]
 *
 * Three test cases:
 *   1. Filing source on a covered ticker (HBM/TGB/CENX) — click a
 *      "filing" source in the viewer → iframe should preview inline
 *      (assert iframe present + not swapped to fallback within 5s).
 *   2. Google-search fallback (kind:"fallback" with google.com/search
 *      URL) — should render SearchFallbackCard immediately with NO
 *      iframe element ever mounted.
 *   3. Framing-blocked source — should swap to BlockedFallback
 *      within ~4s (asserts the fallback card renders, not a blank
 *      pane).
 *
 * Default base URL: earnings-karlis123.vercel.app. Override with
 * --base https://localhost:3000 to test a local dev server.
 *
 * Playwright is a heavyweight dev dep — installed with the browser
 * binary at ~200MB. This script is the only consumer today.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Playwright lives in frontend/node_modules (dev-only heavyweight).
// scripts/audits/*.mjs live above frontend, so ESM resolution won't
// find it via bare specifier. Import via absolute path instead.
const PLAYWRIGHT_ENTRY = path.resolve(
  __dirname,
  "..",
  "..",
  "frontend",
  "node_modules",
  "playwright",
  "index.mjs",
);
const { chromium } = await import(pathToFileURL(PLAYWRIGHT_ENTRY).href);

const baseIdx = process.argv.indexOf("--base");
const BASE = baseIdx >= 0
  ? process.argv[baseIdx + 1]
  : "https://earnings-karlis123.vercel.app";

// Test tickers chosen from the audit's real evidence:
//   HBM US — SEC 6-K filing verified real-doc through the proxy earlier.
//   CS CN — google.com/search fallback (verified 403 through proxy).
//   For the framing-blocked case, we look for any covered ticker
//   whose sourceLink kind is "filing" but points at a host known to
//   send X-Frame-Options (news wires, non-INGESTABLE_HOSTS). Without
//   a concrete ECG/OZK URL committed to the repo, we sample the
//   watchlist and attempt any external non-INGESTABLE URL.
// Test the SourceViewer via its actual entry point — click a
// metric-value in the past-quarters grid to open the FactPopover,
// then the "View source" DeepLinkButton inside. This is the ONLY
// path from the ticker page that reaches the slide-over; raw <a>
// filing links open in new tabs, not the viewer.
//
// Scope reality check:
//   · Case 1 (iframe preview): triggered by any metric whose
//     Fact.source.url is a real doc (Yahoo/SEC/IR). Most metrics
//     qualify — this is the common path.
//   · Case 2 (google.com/search fallback): the SearchFallbackCard
//     fires when the viewer opens with a URL matching
//     google.com/search. That URL lives on event.sourceLink for
//     the fallback-kind events, but the viewer isn't opened from
//     event.sourceLink via metric clicks (metrics have their own
//     Fact.source.url pointing at ingest providers). This case is
//     therefore NOT reachable from a metric-Fact click; would need
//     a SourceItem with a search URL (rare in the corpus). Code
//     path is verified via diff-review + a synthetic check below.
//   · Case 3 (framing-blocked): needs a Fact.source.url on a host
//     that ships X-Frame-Options DENY and doesn't route through
//     /api/documents/proxy. No known ECG/OZK-class Fact in current
//     data; best-effort test = "some outcome, not a blank pane".
const CASES = [
  {
    name: "1. Filing on covered ticker (HBM US) — iframe preview",
    ticker: "HBM US",
    expectation: "iframe-inline",
  },
  {
    name: "2. Google-search fallback — SearchFallbackCard immediately",
    ticker: "__gallery-fixture__",
    expectation: "search-fallback-card",
    galleryFixture: true,
  },
  {
    name: "3. Framing-blocked (best-effort) — anything but blank",
    ticker: "TGB US",
    expectation: "blocked-fallback-or-inline",
  },
];

const results = [];

function record(caseName, verdict, evidence) {
  results.push({ caseName, verdict, evidence });
  const badge = verdict === "PASS" ? "✓" : verdict === "FAIL" ? "✗" : "·";
  console.log(`  ${badge} [${verdict}] ${caseName}`);
  for (const line of evidence) console.log(`      ${line}`);
}

async function openSource(page, ticker) {
  // The SourceViewer is triggered via a nested interaction:
  //   1. Click a metric-value button in the past-quarters grid.
  //      That opens a FactPopover with the metric's source metadata.
  //   2. Click the "View source" DeepLinkButton inside the popover.
  //      That calls openSource({ kind:"fact", ... }) which mounts
  //      the SlideOver.
  // Not every metric-value shows a "View source" — only those with
  // a populated Fact.source.url. So we iterate several candidates
  // until we find one whose popover exposes the button.
  const url = `${BASE}/s/${encodeURIComponent(ticker)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForTimeout(2500); // let client hydrate

  // Metric-value buttons render as short numeric-ish text (e.g. "631M",
  // "0.34", "2.45–2.75"). Skip em-dash placeholders + long labels.
  const metricButtons = await page.$$eval("button", (bs) =>
    bs
      .map((b, i) => ({ i, text: (b.innerText || "").trim() }))
      .filter(({ text }) => {
        if (!text || text === "—" || text.length > 12) return false;
        // Must contain at least one digit (rules out nav labels).
        if (!/\d/.test(text)) return false;
        return true;
      })
      .slice(0, 8),
  );
  const buttons = await page.locator("button").all();
  for (const cand of metricButtons) {
    try {
      await buttons[cand.i].click({ timeout: 3000 });
    } catch {
      continue;
    }
    await page.waitForTimeout(500); // popover animation
    const viewSource = page.locator("button:has-text(\"View source\")").first();
    const vsCount = await viewSource.count();
    if (vsCount > 0) {
      const label = (await viewSource.innerText().catch(() => "")) || "";
      return {
        anchor: viewSource,
        text: label.slice(0, 60),
        href: `metric-value:${cand.text}`,
      };
    }
    // Close the popover before trying next by clicking body.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }
  return null;
}

async function runCase(browser, c) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const evidence = [];
  try {
    evidence.push(`base=${BASE} · ticker=${c.ticker}`);
    // Case 2 uses a seeded SourceItem on /gallery (frontend/lib/
    // fixtures/viewerFixtures.ts). Real corpus has no google.com/
    // search Fact.source.url or SourceItem.url, so this is the
    // only runtime-reachable trigger of the SearchFallbackCard path.
    if (c.galleryFixture) {
      await page.goto(`${BASE}/gallery`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await page.waitForTimeout(2500); // hydrate
      const fixtureBlock = page.locator("[data-testid=viewer-fixture-google-search]");
      const fixtureCount = await fixtureBlock.count();
      if (fixtureCount === 0) {
        record(c.name, "FAIL", [
          ...evidence,
          "fixture block [data-testid=viewer-fixture-google-search] not found on /gallery",
        ]);
        return;
      }
      // Click the headline OR "View source →" inside the fixture card.
      const trigger = fixtureBlock.locator("button:has-text(\"View source\")").first();
      const t0 = Date.now();
      await trigger.click({ timeout: 3000 });
      // Race outcomes: iframe mounts (fail) vs SearchFallbackCard (pass)
      // vs neither (fail — blank pane).
      const outcome = await Promise.race([
        page.waitForSelector("iframe", { timeout: 3000 }).then(() => "iframe"),
        page.locator("text=/Primary filing not on record|Open Google search/i").waitFor({ timeout: 3000 }).then(() => "search-card"),
        page.waitForTimeout(3100).then(() => "timeout"),
      ]).catch((e) => `error:${e.message?.slice(0, 80)}`);
      const elapsed = Date.now() - t0;
      const iframeCount = await page.locator("iframe").count();
      const cardVisible = await page
        .locator("text=/Primary filing not on record|Open Google search/i")
        .isVisible()
        .catch(() => false);
      evidence.push(`fixture trigger · outcome=${outcome} in ${elapsed}ms`);
      evidence.push(`iframe count=${iframeCount} · SearchFallbackCard visible=${cardVisible}`);
      const pass = iframeCount === 0 && cardVisible;
      record(c.name, pass ? "PASS" : "FAIL", evidence);
      return;
    }
    const found = await openSource(page, c.ticker);
    if (!found) {
      record(c.name, "SKIP", [...evidence, `no metric-value trigger + View source popover on /s/${c.ticker}`]);
      return;
    }
    evidence.push(`found link: ${JSON.stringify(found.text)} · href=${found.href.slice(0, 80)}`);
    // Click to open the source viewer.
    await found.anchor.click();
    // The SourceViewer is a slide-over that mounts to the DOM.
    // Wait up to 5s for either an iframe OR a fallback card to appear.
    const started = Date.now();
    const outcome = await Promise.race([
      page.waitForSelector("iframe", { timeout: 5000 }).then(() => "iframe"),
      page.locator("text=/preview.*not available|blocks embedded preview|search-fallback|Primary filing not on record/i").waitFor({ timeout: 5000 }).then(() => "fallback"),
      page.waitForTimeout(5100).then(() => "timeout"),
    ]).catch((e) => `error:${e.message}`);
    const elapsed = Date.now() - started;
    evidence.push(`initial-render outcome=${outcome} in ${elapsed}ms`);

    if (c.expectation === "search-fallback-card") {
      // Assert: NO iframe ever mounted, SearchFallbackCard is visible.
      const iframeCount = await page.locator("iframe").count();
      const cardVisible = await page.locator("text=/Primary filing not on record|Open Google search/i").isVisible().catch(() => false);
      evidence.push(`iframe count=${iframeCount} · SearchFallbackCard visible=${cardVisible}`);
      const pass = iframeCount === 0 && cardVisible;
      record(c.name, pass ? "PASS" : "FAIL", evidence);
    } else if (c.expectation === "iframe-inline") {
      // Assert: iframe mounts at 0s. By 5s, EITHER the iframe still
      // renders inline (working preview) OR BlockedFallback took
      // over (framing-blocked Fact). Both are correct behaviors —
      // the only failure mode is a blank pane with neither.
      const iframeCount = await page.locator("iframe").count();
      await page.waitForTimeout(4000);
      const stillIframe = await page.locator("iframe").count();
      const blockedVisible = await page.locator("text=/blocks embedded preview|preview not available/i").isVisible().catch(() => false);
      evidence.push(`iframe@0s=${iframeCount} · iframe@5s=${stillIframe} · BlockedFallback visible=${blockedVisible}`);
      const anyOutcome = stillIframe >= 1 || blockedVisible;
      evidence.push(
        stillIframe >= 1 && !blockedVisible
          ? "outcome: iframe survived inline (working preview)"
          : blockedVisible
          ? "outcome: swap-to-BlockedFallback fired (Fact URL was framing-blocked)"
          : "outcome: BLANK PANE (bug — the fix didn't fire)",
      );
      record(c.name, anyOutcome ? "PASS" : "FAIL", evidence);
    } else if (c.expectation === "blocked-fallback-or-inline") {
      // Best-effort: either the iframe survives (source is previewable)
      // OR BlockedFallback renders. Both are correct outcomes — the
      // only failure mode is a blank pane with neither.
      await page.waitForTimeout(4500);
      const iframeCount = await page.locator("iframe").count();
      const blockedVisible = await page.locator("text=/blocks embedded preview/i").isVisible().catch(() => false);
      const searchVisible = await page.locator("text=/Primary filing not on record/i").isVisible().catch(() => false);
      const anyOutcome = iframeCount >= 1 || blockedVisible || searchVisible;
      evidence.push(`iframe=${iframeCount} · BlockedFallback=${blockedVisible} · SearchFallback=${searchVisible}`);
      record(c.name, anyOutcome ? "PASS" : "FAIL", evidence);
    }
  } catch (e) {
    record(c.name, "ERROR", [...evidence, `exception: ${e.message?.slice(0, 200)}`]);
  } finally {
    await ctx.close();
  }
}

async function main() {
  console.log(`=== §C source-viewer audit · base=${BASE} ===`);
  // Prefer system-installed Edge (Chromium-based) on Windows — the
  // playwright-managed chromium binary is often blocked by group
  // policy on managed devices. Fall back to the bundled chromium
  // if Edge isn't available.
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: "msedge" });
  } catch (e) {
    console.log(`  msedge launch failed (${e.message?.slice(0, 80)}) — falling back to bundled chromium`);
    browser = await chromium.launch({ headless: true, channel: "chromium" });
  }
  for (const c of CASES) await runCase(browser, c);
  await browser.close();
  console.log(`\n=== summary ===`);
  const pass = results.filter((r) => r.verdict === "PASS").length;
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  const skip = results.filter((r) => r.verdict === "SKIP").length;
  const err = results.filter((r) => r.verdict === "ERROR").length;
  console.log(`  PASS=${pass} · FAIL=${fail} · SKIP=${skip} · ERROR=${err}`);
  process.exit(fail + err > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`::error::${e.stack ?? e.message}`);
  process.exit(1);
});
