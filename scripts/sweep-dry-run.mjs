#!/usr/bin/env node
/**
 * Print what tomorrow's /sweep would do — WITHOUT executing it.
 *
 * Reads data/covered.json + each covered ticker's shard + any
 * existing summary, applies the same "recent AND no summary yet"
 * filter that /sweep.md prescribes, and prints the due list with
 * skip reasons for every covered ticker.
 *
 *   node scripts/sweep-dry-run.mjs
 *
 * No mutations, no commits, no network calls. Purely a read of
 * the current shard + summaries state.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const COVERED_PATH = path.join(ROOT, "data", "covered.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const SUMMARIES_DIR = path.join(ROOT, "data", "summaries");

const TRADING_DAY_WINDOW = 5;

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }
function periodSlug(p) { return p.replace(/\s+/g, "_"); }
function tradingDaysBetween(from, to) {
  // Count business days (Mon-Fri) between two ISO dates, exclusive of start
  // and inclusive of end. Not calendar-precise (no holiday adjustment)
  // — matches sweep.md's stated approximation.
  const start = new Date(from);
  const end = new Date(to);
  let count = 0;
  const cur = new Date(start);
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

async function main() {
  const cover = JSON.parse(await fs.readFile(COVERED_PATH, "utf-8"));
  const tickers = Array.isArray(cover.tickers) ? cover.tickers : [];
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const ticker of tickers) {
    const slug = tickerSlug(ticker);
    const shardPath = path.join(EVENTS_DIR, slug + ".json");
    let shard;
    try { shard = JSON.parse(await fs.readFile(shardPath, "utf-8")); }
    catch { rows.push({ ticker, status: "no-events", detail: "no shard file" }); continue; }
    const events = Array.isArray(shard) ? shard : (shard.events ?? []);
    const past = events.filter((e) => e.eventDate)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
    if (past.length === 0) { rows.push({ ticker, status: "no-events", detail: "shard has no past events" }); continue; }
    const latest = past[0];
    const ageTradingDays = tradingDaysBetween(latest.eventDate, today);
    const summaryPath = path.join(SUMMARIES_DIR, `${slug}_${periodSlug(latest.period)}.json`);
    let summaryExists = false;
    try { await fs.access(summaryPath); summaryExists = true; } catch { /* not present */ }

    if (summaryExists) {
      rows.push({ ticker, status: "already-summarized", latestPeriod: latest.period, eventDate: latest.eventDate, ageTradingDays });
    } else if (ageTradingDays > TRADING_DAY_WINDOW) {
      rows.push({ ticker, status: "stale", latestPeriod: latest.period, eventDate: latest.eventDate, ageTradingDays });
    } else {
      rows.push({ ticker, status: "due", latestPeriod: latest.period, eventDate: latest.eventDate, ageTradingDays });
    }
  }

  const due = rows.filter((r) => r.status === "due");
  const skipped = rows.filter((r) => r.status !== "due");
  console.log(`sweep dry-run · today=${today} · window=${TRADING_DAY_WINDOW} trading days`);
  console.log("");
  if (due.length > 0) {
    console.log(
      `Due:      ${due.map((r) => `${r.ticker} ${r.latestPeriod} (${r.ageTradingDays}d ago)`).join(", ")}`,
    );
  } else {
    console.log(`Due:      (nothing — nothing due path would fire; no commit, exit 0)`);
  }
  console.log(`Skipped:  ${skipped.length} covered names not due`);
  console.log("");
  console.log("Per-ticker breakdown:");
  for (const r of rows) {
    const kv = Object.entries(r).filter(([k]) => k !== "ticker" && k !== "status").map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`  ${r.ticker.padEnd(10)} [${r.status.padEnd(21)}] ${kv}`);
  }
  console.log("");
  console.log(`=== Expected tomorrow ===`);
  if (due.length === 0) {
    console.log("RESULT: skipped — nothing due");
  } else {
    console.log(`Would attempt: ${due.length} ticker${due.length === 1 ? "" : "s"}`);
    console.log(`Final commit (if all succeed): "earnings sweep: ${due.map((r) => `${r.ticker} ${r.latestPeriod}`).join(", ")}"`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
