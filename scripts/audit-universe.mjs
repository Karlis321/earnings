#!/usr/bin/env node
/**
 * Per-ticker completeness audit. Verifies six coverage dimensions for
 * every operating entity in the registry:
 *   1. financials    — any past event has at least one metric.actual
 *   2. latest_report — a past event exists (max eventDate)
 *   3. sources       — every event on the shard has event.sourceLink
 *   4. estimates     — latest past event has EPS or revenue estimate
 *   5. reactions     — latest past event has d1 or d3 absReturn populated
 *   6. news          — latest past event has ≥1 sources.items[] entry
 *
 * Prints a summary and writes scripts/audits/audit-universe.json with
 * a per-ticker rollup + a gap list per dimension.
 *
 *   node scripts/audit-universe.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REG_PATH = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

function tickerSlug(t) { return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_"); }

async function main() {
  const reg = JSON.parse(await fs.readFile(REG_PATH, "utf-8"));
  const entities = (reg.entities ?? []).filter((e) => e.securityType === "operating");

  const perTicker = [];
  const gaps = {
    no_shard: [],
    no_past_event: [],
    latest_missing_financials: [],
    events_missing_sourcelink: [],
    latest_missing_estimate: [],
    latest_missing_reaction: [],
    latest_missing_news: [],
  };
  let allEventsCount = 0;
  let allSourceLinkCount = 0;

  for (const entity of entities) {
    const shardPath = path.join(EVENTS_DIR, tickerSlug(entity.ticker) + ".json");
    let shard;
    try {
      shard = JSON.parse(await fs.readFile(shardPath, "utf-8"));
    } catch {
      gaps.no_shard.push(entity.ticker);
      perTicker.push({ ticker: entity.ticker, shard: false });
      continue;
    }
    const events = Array.isArray(shard) ? shard : shard.events ?? [];
    allEventsCount += events.length;
    const missingSrcOnShard = events.filter((e) => !e.sourceLink?.url).length;
    allSourceLinkCount += events.length - missingSrcOnShard;
    if (missingSrcOnShard > 0) gaps.events_missing_sourcelink.push({ ticker: entity.ticker, missing: missingSrcOnShard });

    const past = events
      .filter((e) => e.eventDate)
      .sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));

    if (past.length === 0) {
      gaps.no_past_event.push(entity.ticker);
      perTicker.push({ ticker: entity.ticker, shard: true, hasPast: false });
      continue;
    }
    const latest = past[0];

    const hasFinancials = (latest.metrics ?? []).some((m) => m.actual?.value != null);
    const hasEstimate = (latest.metrics ?? []).some((m) => m.estimate?.value != null);
    // Reaction: d1 or d3 with a value AND status matured/clipped.
    const points = latest.reaction?.points ?? [];
    // A reaction "exists" if d1 OR d3 has a computed absReturn.
    // (Legacy points may not carry a status field but still have a
    // real value — those count.)
    const hasReaction = points.some(
      (p) => (p.horizon === "d1" || p.horizon === "d3") && p.absReturn != null,
    );
    const hasNews = Array.isArray(latest.sources?.items) && latest.sources.items.length > 0;

    if (!hasFinancials) gaps.latest_missing_financials.push({ ticker: entity.ticker, period: latest.period, eventDate: latest.eventDate });
    if (!hasEstimate) gaps.latest_missing_estimate.push({ ticker: entity.ticker, period: latest.period, eventDate: latest.eventDate });
    if (!hasReaction) gaps.latest_missing_reaction.push({ ticker: entity.ticker, period: latest.period, eventDate: latest.eventDate, points: points.map((p) => ({ h: p.horizon, r: p.absReturn, s: p.status })) });
    if (!hasNews) gaps.latest_missing_news.push({ ticker: entity.ticker, period: latest.period, eventDate: latest.eventDate });

    perTicker.push({
      ticker: entity.ticker,
      shard: true,
      hasPast: true,
      latest: { period: latest.period, eventDate: latest.eventDate },
      hasFinancials,
      hasEstimate,
      hasReaction,
      hasNews,
      hasSourceLink: !!latest.sourceLink?.url,
    });
  }

  const total = entities.length;
  const withShard = total - gaps.no_shard.length;
  const withPast = total - gaps.no_shard.length - gaps.no_past_event.length;
  const withFinancials = withPast - gaps.latest_missing_financials.length;
  const withEstimate = withPast - gaps.latest_missing_estimate.length;
  const withReaction = withPast - gaps.latest_missing_reaction.length;
  const withNews = withPast - gaps.latest_missing_news.length;

  const summary = {
    total_operating: total,
    with_shard: withShard,
    with_past_event: withPast,
    latest_has_financials: withFinancials,
    latest_has_estimate: withEstimate,
    latest_has_reaction: withReaction,
    latest_has_news: withNews,
    all_events_count: allEventsCount,
    all_events_with_sourcelink: allSourceLinkCount,
  };

  console.log("=== audit-universe ===");
  const pct = (n) => ((n / total) * 100).toFixed(1) + "%";
  console.log(`Total operating entities:            ${total}`);
  console.log(`With shard file:                     ${withShard.toString().padStart(5)} (${pct(withShard)})`);
  console.log(`With ≥1 past event:                  ${withPast.toString().padStart(5)} (${pct(withPast)})`);
  console.log(`Latest event has financial actuals:  ${withFinancials.toString().padStart(5)} (${pct(withFinancials)})`);
  console.log(`Latest event has ≥1 estimate:        ${withEstimate.toString().padStart(5)} (${pct(withEstimate)})`);
  console.log(`Latest event has d1|d3 reaction:     ${withReaction.toString().padStart(5)} (${pct(withReaction)})`);
  console.log(`Latest event has ≥1 news item:       ${withNews.toString().padStart(5)} (${pct(withNews)})`);
  console.log();
  console.log(`Events with sourceLink:              ${allSourceLinkCount}/${allEventsCount} (${((allSourceLinkCount/allEventsCount)*100).toFixed(1)}%)`);
  console.log();
  console.log("Gaps:");
  console.log(`  no shard file:               ${gaps.no_shard.length}`);
  console.log(`  no past event:               ${gaps.no_past_event.length}`);
  console.log(`  events missing sourceLink:   ${gaps.events_missing_sourcelink.length} shards`);
  console.log(`  latest missing financials:   ${gaps.latest_missing_financials.length}`);
  console.log(`  latest missing estimate:     ${gaps.latest_missing_estimate.length}`);
  console.log(`  latest missing reaction:     ${gaps.latest_missing_reaction.length}`);
  console.log(`  latest missing news:         ${gaps.latest_missing_news.length}`);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "audit-universe.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), summary, gaps, perTicker }, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/audit-universe.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
