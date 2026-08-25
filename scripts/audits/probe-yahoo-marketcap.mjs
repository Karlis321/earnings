#!/usr/bin/env node
/**
 * One-off probe: compare Yahoo v7 /quote (batch) vs v10 quoteSummary
 * (per-symbol) for the marketCap field. Delete once we know which
 * endpoint refresh-marketcap.mjs should use.
 *
 *   node scripts/audits/probe-yahoo-marketcap.mjs
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const H = {
  "User-Agent": UA,
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};
// Pull the first 100 yahooSymbols from the real registry so we
// exercise the same batch shape refresh-marketcap.mjs uses.
import fs from "node:fs/promises";
const reg = JSON.parse(await fs.readFile("data/entity-registry.json", "utf-8"));
const SYMBOLS = (reg.entities ?? [])
  .filter((e) => e.yahooSymbol && e.isCanonical)
  .slice(0, 100)
  .map((e) => e.yahooSymbol);

function parseCookies(setCookies) {
  const pairs = new Map();
  for (const raw of setCookies) {
    const firstPart = raw.split(";", 1)[0]?.trim();
    if (!firstPart) continue;
    const eq = firstPart.indexOf("=");
    if (eq < 0) continue;
    pairs.set(firstPart.slice(0, eq).trim(), firstPart.slice(eq + 1).trim());
  }
  return [...pairs].map(([n, v]) => `${n}=${v}`).join("; ");
}

async function getCrumb() {
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
    redirect: "manual",
  });
  const setCookies = typeof r1.headers.getSetCookie === "function"
    ? r1.headers.getSetCookie()
    : (r1.headers.get("set-cookie") ? [r1.headers.get("set-cookie")] : []);
  const cookieHeader = parseCookies(setCookies);
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookieHeader },
  });
  const crumb = (await r2.text()).trim();
  return { crumb, cookieHeader };
}

async function probeV7Batch(state) {
  const url =
    `https://query1.finance.yahoo.com/v7/finance/quote` +
    `?symbols=${SYMBOLS.join(",")}` +
    `&crumb=${encodeURIComponent(state.crumb)}`;
  const r = await fetch(url, { headers: { ...H, Cookie: state.cookieHeader } });
  console.log(`v7 /quote batch · http=${r.status}`);
  if (!r.ok) {
    console.log("  body:", (await r.text()).slice(0, 200));
    return;
  }
  const j = await r.json();
  const rows = j.quoteResponse?.result ?? [];
  const withCap = rows.filter((r) => typeof r.marketCap === "number");
  console.log(`  rows: ${rows.length} · withMarketCap: ${withCap.length}`);
  if (rows.length > 0) {
    console.log(
      `  first: ${rows[0].symbol} · marketCap=${rows[0].marketCap ?? "null"} · currency=${rows[0].currency ?? "?"}`,
    );
  }
  // Highlight the missing ones — cases where the batch returned a row
  // but marketCap was null (Yahoo doesn't populate cap for ETFs or
  // some ADRs; those symbols look "no-data" to the current script).
  const nullCap = rows.filter((r) => r.marketCap == null);
  if (nullCap.length > 0) {
    console.log(`  null-cap symbols: ${nullCap.length}`);
    console.log(`  first null-cap row keys:`, Object.keys(nullCap[0]).filter(k => nullCap[0][k] != null).slice(0, 30).join(", "));
    console.log(`  first null-cap netAssets/totalAssets:`, nullCap[0].netAssets, "/", nullCap[0].totalAssets);
  }
  const missingRows = SYMBOLS.filter((s) => !rows.some((r) => r.symbol === s));
  if (missingRows.length > 0) console.log(`  totally-missing (first 10): ${missingRows.slice(0, 10).join(", ")}`);
}

async function probeV10QuoteSummary(sym, state) {
  const url =
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}` +
    `?modules=price,summaryDetail&formatted=true&crumb=${encodeURIComponent(state.crumb)}`;
  const r = await fetch(url, { headers: { ...H, Cookie: state.cookieHeader } });
  if (!r.ok) {
    console.log(`v10 quoteSummary ${sym} · http=${r.status}`);
    return;
  }
  const j = await r.json();
  const result = j.quoteSummary?.result?.[0];
  const price = result?.price ?? {};
  const summary = result?.summaryDetail ?? {};
  const mc = price.marketCap?.raw ?? summary.marketCap?.raw ?? null;
  const ccy = price.currency ?? summary.currency ?? null;
  const p = price.regularMarketPrice?.raw ?? null;
  console.log(
    `v10 ${sym.padEnd(6)} marketCap=${mc ?? "null"} currency=${ccy ?? "?"} price=${p ?? "null"}`,
  );
}

async function main() {
  const state = await getCrumb();
  console.log(`crumb: ${state.crumb.slice(0, 6)}… cookie: ${state.cookieHeader.slice(0, 50)}…\n`);
  console.log("=== v7 /quote (batch) ===");
  await probeV7Batch(state);
  console.log("\n=== v10 /quoteSummary (per-symbol, first 10) ===");
  for (const sym of SYMBOLS.slice(0, 10)) {
    try { await probeV10QuoteSummary(sym, state); } catch (e) { console.log(`  ${sym} error:`, e.message); }
    await new Promise((r) => setTimeout(r, 300));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
