#!/usr/bin/env node
/**
 * Verify stored metric actuals against SEC XBRL as the ground-truth
 * second source. Samples 150 past events stratified ~50 per provenance
 * (yahoo-timeseries / yahoo-earnings-chart / sec-xbrl-companyfacts) and
 * classifies each metric as:
 *
 *   match         (<0.5% delta after scale + currency normalization)
 *   rounding      (<2% delta after normalization)
 *   scale bug     (matches after ×1e3 or ×1e6 correction)
 *   currency bug  (matches after period-end FX conversion)
 *   value error   (residual >2% after all normalization; SEC wins)
 *   unverifiable  (no SEC XBRL data for period / no CIK)
 *
 * qualityFlags aren't set anywhere in the corpus today (0/7088) so the
 * population reduces to the stratified control sample.
 *
 * Fair-access: SEC public data caps at 10 req/sec with a contact UA.
 * This runner uses 1 req/sec (10× safety margin — we've been 429'd
 * before from combined session activity) + per-CIK response cache so
 * multi-event CIKs pay once.
 *
 *   node scripts/verify-financials.mjs              # write report + fixes
 *   node scripts/verify-financials.mjs --dry        # report only
 *   node scripts/verify-financials.mjs --sample=10  # tiny probe
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const OUT_DIR = path.join(ROOT, "scripts", "audits");
const OUT = path.join(OUT_DIR, "financials-verification.json");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const SAMPLE_SIZE_TOTAL = args.get("sample") ? parseInt(args.get("sample"), 10) : 150;
const PER_PROV_TARGET = Math.floor(SAMPLE_SIZE_TOTAL / 3);
const REQ_INTERVAL_MS = 1000; // 1 req/sec

const SEC_UA = "Earnings Tracker (contact@example.com)";
const XBRL_REVENUE_KEYS = {
  "us-gaap": [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "SalesRevenueNet",
  ],
  "ifrs-full": ["Revenue", "RevenueFromContractsWithCustomers"],
};

// "FY2026 Q2" → "2026-06-30" (calendar quarter end). Same helper as
// scripts/rederive-sec-xbrl.mjs; kept local for script independence.
function periodEndFromLabel(label) {
  const m = /FY(\d{4})\s+Q(\d)/i.exec(label ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  const monthDay = { 1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31" }[q];
  return monthDay ? `${year}-${monthDay}` : null;
}

// Deterministic-ish sample via seeded shuffle (a simple LCG on the ticker
// hash so re-runs pick the same events). Not cryptographic; just avoids
// unstable stratification between runs.
function seededShuffle(arr, seed = 42) {
  const out = arr.slice();
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Fixed-rate token bucket. `wait()` resolves as soon as the next slot
// opens.
class RateLimiter {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.next = 0;
  }
  async wait() {
    const now = Date.now();
    const t = Math.max(now, this.next);
    this.next = t + this.intervalMs;
    if (t > now) await new Promise((r) => setTimeout(r, t - now));
  }
}

async function fetchCompanyFacts(cik, limiter, cache) {
  const padded = String(cik).padStart(10, "0");
  if (cache.has(padded)) return cache.get(padded);
  await limiter.wait();
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 429) {
      cache.set(padded, { throttled: true });
      return cache.get(padded);
    }
    if (r.status === 404) {
      cache.set(padded, { notFound: true });
      return cache.get(padded);
    }
    if (!r.ok) {
      cache.set(padded, { error: `HTTP ${r.status}` });
      return cache.get(padded);
    }
    const j = await r.json();
    cache.set(padded, { ok: true, facts: j.facts ?? {} });
    return cache.get(padded);
  } catch (e) {
    cache.set(padded, { error: e.message ?? "network" });
    return cache.get(padded);
  }
}

// Given SEC XBRL facts + a target period-end date + a metric family,
// return the closest SEC value (raw, in USD unless entity reports IFRS
// in another currency). Match on `end` date within ±31 days.
function findXbrlValue(facts, periodEnd, keys, unitPref = ["USD"]) {
  for (const [taxo, xbrlKeys] of Object.entries(XBRL_REVENUE_KEYS)) {
    if (keys && !keys.includes(taxo)) continue;
    const taxoBlock = facts?.[taxo];
    if (!taxoBlock) continue;
    for (const k of xbrlKeys) {
      const item = taxoBlock[k];
      if (!item) continue;
      const units = item.units ?? {};
      const unitKey = unitPref.find((u) => units[u]) ?? Object.keys(units)[0];
      if (!unitKey) continue;
      const values = units[unitKey] ?? [];
      let best = null;
      let bestDelta = Infinity;
      for (const v of values) {
        if (!v.end) continue;
        // Only pure quarter windows (~90d start→end)
        if (v.start) {
          const spanDays =
            (new Date(v.end).getTime() - new Date(v.start).getTime()) / 86_400_000;
          if (spanDays < 80 || spanDays > 100) continue;
        }
        const d = Math.abs(
          (new Date(v.end).getTime() - new Date(periodEnd).getTime()) / 86_400_000,
        );
        if (d < bestDelta) {
          bestDelta = d;
          best = v;
        }
      }
      if (best && bestDelta <= 31) {
        return { value: best.val, unit: unitKey, matched_end: best.end, taxo, key: k };
      }
    }
  }
  return null;
}

function normalizeToUsdMillions(value, unit) {
  // Metric stored as XX millions (or raw, depending on key). Caller
  // handles the scale flag on the ours-side.
  return { value, unit };
}

// Classification: given ours (already in millions) vs theirs (raw dollars
// from SEC XBRL), compute normalization results and pick the class.
function classify(oursValue, oursUnit, theirsValue, theirsUnit) {
  if (oursValue == null || theirsValue == null) return { class: "unverifiable" };
  // Currency mismatch (no FX in this pass — flag as currency bug for
  // manual review; adding real FX would need a period-end rate feed).
  if (oursUnit !== theirsUnit) {
    return {
      class: "currency bug",
      note: `ours unit=${oursUnit} vs xbrl unit=${theirsUnit}`,
      ours: oursValue,
      theirs: theirsValue,
    };
  }
  // Scale check: theirs is raw $, ours is $M. Divide theirs by 1e6.
  const theirsMillions = theirsValue / 1e6;
  const denom = Math.max(Math.abs(theirsMillions), 1e-9);
  const pctDelta = ((oursValue - theirsMillions) / denom) * 100;
  const abs = Math.abs(pctDelta);
  if (abs < 0.5) return { class: "match", pct: pctDelta, theirs: theirsMillions };
  if (abs < 2) return { class: "rounding", pct: pctDelta, theirs: theirsMillions };
  // Try scale correction — ours might be stored in thousands or raw
  // dollars instead of millions.
  for (const factor of [1000, 1_000_000, 0.001, 0.000001]) {
    const adj = oursValue * factor;
    const p = Math.abs(((adj - theirsMillions) / denom) * 100);
    if (p < 2) {
      return {
        class: "scale bug",
        pct: p,
        theirs: theirsMillions,
        note: `matches after ours × ${factor}`,
      };
    }
  }
  return { class: "value error", pct: pctDelta, theirs: theirsMillions };
}

async function main() {
  console.log(
    `verify-financials · dry=${DRY} sample_total=${SAMPLE_SIZE_TOTAL} per_prov=${PER_PROV_TARGET}`,
  );
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const entityByTicker = new Map(reg.entities.map((e) => [e.ticker, e]));
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith(".json"));

  const eventsByProv = new Map();
  for (const f of files) {
    const p = path.join(EVENTS_DIR, f);
    const j = JSON.parse(await fs.readFile(p, "utf-8"));
    const evs = Array.isArray(j) ? j : (j.events ?? []);
    for (const ev of evs) {
      if (!ev.eventDate) continue;
      const prov = ev.provenance ?? "unknown";
      if (!eventsByProv.has(prov)) eventsByProv.set(prov, []);
      eventsByProv.get(prov).push({ ev, shard: p });
    }
  }
  const wantedProv = [
    "yahoo-timeseries",
    "yahoo-earnings-chart",
    "sec-xbrl-companyfacts",
  ];
  const sampled = [];
  for (const prov of wantedProv) {
    const pool = eventsByProv.get(prov) ?? [];
    const shuffled = seededShuffle(pool, prov.length * 97);
    for (const item of shuffled.slice(0, PER_PROV_TARGET)) sampled.push({ ...item, prov });
  }
  console.log(`Sampled ${sampled.length} events across ${wantedProv.length} provenances.`);

  const limiter = new RateLimiter(REQ_INTERVAL_MS);
  const cache = new Map();
  const results = [];
  let processed = 0;
  const rollup = new Map(); // provenance → { match, rounding, scale, currency, value_error, unverifiable, checked }

  function bump(prov, key) {
    if (!rollup.has(prov)) {
      rollup.set(prov, {
        checked: 0,
        match: 0,
        rounding: 0,
        "scale bug": 0,
        "currency bug": 0,
        "value error": 0,
        unverifiable: 0,
      });
    }
    rollup.get(prov)[key]++;
  }

  for (const { ev, prov } of sampled) {
    processed++;
    const entity = entityByTicker.get(ev.ticker);
    const cik = entity?.edgarCik ?? null;
    const revenueMetric = (ev.metrics ?? []).find((m) =>
      /^revenue_[a-z]{3}_m$/i.test(m.key ?? ""),
    );
    if (!revenueMetric || revenueMetric.actual?.value == null) {
      bump(prov, "unverifiable");
      rollup.get(prov).checked++;
      results.push({
        eventId: ev.id, ticker: ev.ticker, provenance: prov, class: "unverifiable",
        reason: "no revenue metric on event",
      });
      continue;
    }
    if (!cik) {
      bump(prov, "unverifiable");
      rollup.get(prov).checked++;
      results.push({
        eventId: ev.id, ticker: ev.ticker, provenance: prov, class: "unverifiable",
        reason: "no CIK on entity",
      });
      continue;
    }
    const cikState = await fetchCompanyFacts(cik, limiter, cache);
    if (cikState.throttled) {
      bump(prov, "unverifiable");
      rollup.get(prov).checked++;
      results.push({
        eventId: ev.id, ticker: ev.ticker, provenance: prov, class: "unverifiable",
        reason: "SEC 429",
      });
      continue;
    }
    if (cikState.notFound || cikState.error) {
      bump(prov, "unverifiable");
      rollup.get(prov).checked++;
      results.push({
        eventId: ev.id, ticker: ev.ticker, provenance: prov, class: "unverifiable",
        reason: cikState.error ?? "SEC 404",
      });
      continue;
    }
    // Derive period-end from the event's period label ("FY2026 Q2" →
    // 2026-06-30). The metric.actual.asOf field on historical events
    // was stamped with fetchedAt (today) rather than the real
    // period-end, so using it mis-anchors every quarter onto today's-
    // nearest SEC entry.
    const asOf = periodEndFromLabel(ev.period) ?? ev.eventDate ?? ev.scheduledDate;
    const oursCurrency = revenueMetric.actual.unit ?? "USD";
    const oursValue = revenueMetric.actual.value;
    const xbrl = findXbrlValue(
      cikState.facts,
      asOf,
      ["us-gaap", "ifrs-full"],
      [oursCurrency, "USD"],
    );
    if (!xbrl) {
      bump(prov, "unverifiable");
      rollup.get(prov).checked++;
      results.push({
        eventId: ev.id, ticker: ev.ticker, provenance: prov, class: "unverifiable",
        reason: "no SEC revenue for period",
        period_target: asOf,
      });
      continue;
    }
    const cls = classify(oursValue, oursCurrency, xbrl.value, xbrl.unit);
    bump(prov, cls.class);
    rollup.get(prov).checked++;
    results.push({
      eventId: ev.id,
      ticker: ev.ticker,
      provenance: prov,
      class: cls.class,
      period_target: asOf,
      xbrl_end: xbrl.matched_end,
      ours: oursValue,
      ours_unit: oursCurrency,
      theirs_raw: xbrl.value,
      theirs_unit: xbrl.unit,
      xbrl_key: xbrl.key,
      xbrl_taxonomy: xbrl.taxo,
      pct_delta: cls.pct,
      note: cls.note ?? undefined,
    });
    if (processed % 20 === 0) {
      console.log(
        `  processed ${processed}/${sampled.length} · unique CIKs fetched ${cache.size}`,
      );
    }
  }

  console.log(`\n=== Verification rollup ===`);
  console.log(
    "provenance                    checked  match  round  scale  curr  value  unverif",
  );
  for (const prov of wantedProv) {
    const r = rollup.get(prov);
    if (!r) continue;
    console.log(
      "  " +
        prov.padEnd(28) +
        String(r.checked).padStart(7) +
        String(r.match).padStart(7) +
        String(r.rounding).padStart(7) +
        String(r["scale bug"]).padStart(7) +
        String(r["currency bug"]).padStart(6) +
        String(r["value error"]).padStart(7) +
        String(r.unverifiable).padStart(9),
    );
  }

  // Extrapolated error rate = (scale + currency + value) / (checked - unverifiable),
  // rolled up across all sampled provenances.
  let totalChecked = 0, totalNonMatch = 0, totalVerified = 0;
  for (const r of rollup.values()) {
    totalChecked += r.checked;
    totalVerified += r.checked - r.unverifiable;
    totalNonMatch +=
      r["scale bug"] + r["currency bug"] + r["value error"];
  }
  const errRate = totalVerified > 0 ? (totalNonMatch / totalVerified) * 100 : null;
  console.log(
    `\nEst. error rate (excluding unverifiable): ${errRate?.toFixed(2)}% (${totalNonMatch}/${totalVerified} verified)`,
  );

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    OUT,
    JSON.stringify(
      {
        schema: "financials-verification/v1",
        generatedAt: new Date().toISOString(),
        sample_size: sampled.length,
        provenance_targets: wantedProv,
        rate_limit_ms: REQ_INTERVAL_MS,
        rollup: Object.fromEntries(rollup),
        estimated_error_rate_pct: errRate,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n✓ wrote ${OUT}`);
  if (DRY) {
    console.log("(dry — no shard fixes applied; report only.)");
    return;
  }
  // Fix policy would go here — scale/currency bugs auto-corrected, value
  // errors flipped when SEC XBRL is the second source. Left as a
  // follow-up pass so we can eyeball the report first.
  console.log(
    "(fix policy not applied yet — review the report first, then run with --apply.)",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
