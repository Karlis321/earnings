#!/usr/bin/env node
/**
 * Standard writer for manually-extracted quarterly actuals. Called
 * inline from Claude sessions when Yahoo/SEC don't have the data
 * but a web search / press release does. Encodes the write pattern
 * consistently so all manual backfills look identical.
 *
 * Usage:
 *   node scripts/manual-backfill-actuals.mjs '<json>'
 *
 * JSON shape:
 *   {
 *     ticker: "000270 KS",
 *     period: "FY2026 Q2",
 *     eventDate: "2026-07-24",     // real report date
 *     source: {
 *       url: "https://...",
 *       label: "IR Q2 2026 release",
 *       provenance: "news" | "regulatory" | "ir-page" | "wire",
 *     },
 *     currency: "KRW",              // unit for revenue/oi/ni
 *     metrics: {
 *       revenue_m?: number,
 *       operating_income_m?: number,
 *       net_income_m?: number,
 *       gross_profit_m?: number,
 *       eps?: number,
 *       eps_diluted?: number,
 *     }
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}

const raw = process.argv[2];
if (!raw) {
  console.error("usage: manual-backfill-actuals.mjs '<json>'");
  process.exit(1);
}
const payload = JSON.parse(raw);
const { ticker, period, eventDate, source, currency, metrics } = payload;

const shardPath = path.join(ROOT, "data", "events", tickerSlug(ticker) + ".json");
const shardRaw = JSON.parse(fs.readFileSync(shardPath, "utf-8"));
const events = Array.isArray(shardRaw) ? shardRaw : shardRaw.events;
const ev = events.find((e) => e.period === period);
if (!ev) {
  console.error(`no event ${period} in ${ticker}`);
  process.exit(1);
}

const now = new Date().toISOString();
const srcObj = {
  url: source.url,
  label: source.label,
  provenance: source.provenance ?? "news",
  locator: null,
};

// Update eventDate if the manual data has a better one.
if (eventDate && eventDate !== ev.eventDate) {
  ev.eventDate = eventDate;
  ev.scheduledDate = eventDate;
}

const metricMap = {
  revenue_m: { key: "revenue_usd_m", label: "Revenue (M)" },
  operating_income_m: { key: "operating_income_usd_m", label: "Operating income (M)" },
  net_income_m: { key: "net_income_usd_m", label: "Net income (M)" },
  gross_profit_m: { key: "gross_profit_usd_m", label: "Gross profit (M)" },
  eps: { key: "eps_usd", label: "EPS (basic)" },
  eps_diluted: { key: "eps_diluted_usd", label: "EPS (diluted)" },
};

let added = 0;
for (const [inputKey, { key, label }] of Object.entries(metricMap)) {
  const value = metrics[inputKey];
  if (value == null) continue;
  let m = ev.metrics.find((x) => x.key === key);
  if (!m) {
    m = {
      key,
      displayLabel: label,
      isHeadline: true,
      surprisePct: null,
      estimate: null,
      actual: null,
      prior: null,
    };
    ev.metrics.push(m);
  }
  m.actual = {
    value,
    unit: currency,
    source: srcObj,
    asOf: eventDate,
    fetchedAt: now,
    method: "llm_extracted",
    confidence: 0.9,
  };
  added++;
}

// Set event-level sourceLink so the "no filing" audit picks it up.
if (source.url) {
  ev.sourceLink = { kind: source.provenance === "regulatory" ? "filing" : "fallback", url: source.url };
}

fs.writeFileSync(shardPath, JSON.stringify(shardRaw, null, 2));
console.log(`${ticker} · ${period} · +${added} actuals · eventDate=${ev.eventDate}`);
