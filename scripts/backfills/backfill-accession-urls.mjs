#!/usr/bin/env node
/**
 * Upgrade event.sourceLink from the EDGAR CIK-lookup index page (fallback)
 * to the direct filing URL (kind: "filing") for every event whose
 * provenance is sec-xbrl-companyfacts or sec-submissions AND whose entity
 * carries edgarCik.
 *
 * Strategy (mirrors matchAccession in frontend/server/lib/cronDetections.ts):
 *   1. Fetch https://data.sec.gov/submissions/CIK{padded10}.json once per
 *      CIK across the whole run. Cache the response and reuse for every
 *      event on that CIK.
 *   2. From filings.recent (form[] / filingDate[] / accessionNumber[] /
 *      primaryDocument[]), keep periodic forms only: 10-Q, 10-K, 20-F,
 *      40-F, 6-K.
 *   3. Per event, prefer 10-Q (or 20-F/6-K for foreign) for quarterly
 *      periods, 10-K/20-F for FY-only periods. Match on filingDate within
 *      ±14 days of event.eventDate (or scheduledDate). Closest date wins.
 *   4. Build canonical URL:
 *        https://www.sec.gov/Archives/edgar/data/{cik-no-leading-zeros}/
 *        {accessionNoDashes}/{primaryDocument}
 *   5. Rewrite event.sourceLink = { url, kind: "filing" }.
 *
 * Fair-access: SEC public data is 10 req/sec max with a contact User-Agent.
 * The script uses a token bucket + max concurrency 8 to stay well under.
 * Yahoo-provenance events without a CIK keep their existing fallback (this
 * script only touches sec-* provenance).
 *
 *   node scripts/backfill-accession-urls.mjs         # write
 *   node scripts/backfill-accession-urls.mjs --dry
 *   node scripts/backfill-accession-urls.mjs --limit=200   # cap CIK fetches
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EARNINGS = path.join(ROOT, "data", "earnings.json");
const REGISTRY = path.join(ROOT, "data", "entity-registry.json");
const EVENTS_DIR = path.join(ROOT, "data", "events");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const LIMIT = args.get("limit") ? Number(args.get("limit")) : null;

const SEC_UA = "Earnings Tracker (contact@example.com)";
const SEC_HOST = "https://data.sec.gov";
const MAX_CONCURRENCY = 1;
const MIN_INTERVAL_MS = 1500; // <= ~0.67 req/s — very conservative to recover from prior 429 throttle

const PREFERRED_FORMS = new Set(["10-Q", "10-K", "20-F", "40-F", "6-K"]);

// Serialize the rate-limit gate across all concurrent workers. Each call
// takes a "slot" that is at least MIN_INTERVAL_MS after the previous slot;
// that guarantees a global rate <= 1/MIN_INTERVAL_MS regardless of
// concurrency.
let nextSlotAt = 0;
async function rateGate() {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_INTERVAL_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function fetchSubmissions(paddedCik, attempt = 0) {
  await rateGate();
  const url = `${SEC_HOST}/submissions/CIK${paddedCik}.json`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(25_000),
    });
    if (r.status === 429 || r.status === 503) {
      if (attempt < 4) {
        const backoff = 5_000 * Math.pow(2, attempt); // 5s, 10s, 20s, 40s
        await new Promise((res) => setTimeout(res, backoff));
        return fetchSubmissions(paddedCik, attempt + 1);
      }
      return null;
    }
    if (!r.ok) return null;
    return await r.json();
  } catch {
    if (attempt < 1) {
      await new Promise((res) => setTimeout(res, 500));
      return fetchSubmissions(paddedCik, attempt + 1);
    }
    return null;
  }
}

function candidatesFromSubmissions(sub) {
  const recent = sub?.filings?.recent ?? {};
  const forms = recent.form ?? [];
  const dates = recent.filingDate ?? [];
  const accs = recent.accessionNumber ?? [];
  const docs = recent.primaryDocument ?? [];
  const out = [];
  for (let i = 0; i < forms.length; i++) {
    if (!PREFERRED_FORMS.has(forms[i])) continue;
    if (!accs[i] || !docs[i] || !dates[i]) continue;
    out.push({
      form: forms[i],
      filingDate: dates[i],
      accessionNumber: accs[i],
      primaryDocument: docs[i],
    });
  }
  return out;
}

function matchAccession(event, candidates) {
  const anchorIso = event.eventDate ?? event.scheduledDate;
  if (!anchorIso) return null;
  const anchor = new Date(anchorIso).getTime();
  const isFY = /^FY\d{4}$/.test((event.period ?? "").trim());
  const preferRank = (form) => {
    if (isFY && (form === "10-K" || form === "20-F")) return 0;
    if (!isFY && (form === "10-Q" || form === "6-K")) return 0;
    return 1;
  };
  let best = null;
  for (const c of candidates) {
    const diffDays =
      Math.abs(new Date(c.filingDate).getTime() - anchor) / 86_400_000;
    if (diffDays > 14) continue;
    const rank = preferRank(c.form);
    const score = { c, diff: diffDays, rank };
    if (
      !best ||
      score.rank < best.rank ||
      (score.rank === best.rank && score.diff < best.diff)
    ) {
      best = score;
    }
  }
  return best?.c ?? null;
}

function buildAccessionUrl(paddedCik, accessionNumber, primaryDocument) {
  const cikNoLeading = String(Number(paddedCik));
  const accNoDashes = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoLeading}/${accNoDashes}/${primaryDocument}`;
}

async function readShards() {
  const files = (await fs.readdir(EVENTS_DIR)).filter((f) =>
    f.endsWith(".json"),
  );
  const shards = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(EVENTS_DIR, f), "utf-8");
    const parsed = JSON.parse(raw);
    const evs = Array.isArray(parsed) ? parsed : parsed.events ?? [];
    shards.push({ file: f, parsed, isArray: Array.isArray(parsed), events: evs });
  }
  return shards;
}

async function main() {
  console.log(`backfill-accession-urls · dry=${DRY}${LIMIT ? ` limit=${LIMIT}` : ""}`);
  const reg = JSON.parse(await fs.readFile(REGISTRY, "utf-8"));
  const entityByTicker = new Map(reg.entities.map((e) => [e.ticker, e]));

  const shards = await readShards();
  const totalEvents = shards.reduce((n, s) => n + s.events.length, 0);
  console.log(`Shards: ${shards.length} · events: ${totalEvents}`);

  // Baseline sourceLink kind counts before any changes.
  const before = { filing: 0, fallback: 0, none: 0 };
  for (const s of shards) {
    for (const ev of s.events) {
      const link = ev.sourceLink;
      if (!link) before.none++;
      else if (link.kind === "filing") before.filing++;
      else before.fallback++;
    }
  }
  console.log(
    `Before: filing=${before.filing} · fallback=${before.fallback} · none=${before.none}`,
  );

  // Collect the unique CIKs to fetch — one submissions call per CIK across
  // the whole run. Only touch SEC-provenance events with a CIK.
  const cikToTicker = new Map(); // paddedCik → sample ticker (for logging)
  const eligibleEvents = 0;
  const cikTargets = new Map(); // paddedCik → events[]
  for (const s of shards) {
    for (const ev of s.events) {
      const prov = ev.provenance;
      if (prov !== "sec-xbrl-companyfacts" && prov !== "sec-submissions") continue;
      const entity = entityByTicker.get(ev.ticker);
      if (!entity?.edgarCik) continue;
      const padded = String(entity.edgarCik).padStart(10, "0");
      cikToTicker.set(padded, entity.ticker);
      if (!cikTargets.has(padded)) cikTargets.set(padded, []);
      cikTargets.get(padded).push({ shard: s, ev, entity, padded });
    }
  }
  console.log(`Unique CIKs to resolve: ${cikTargets.size}`);
  console.log(
    `Eligible sec-* events with CIK: ${[...cikTargets.values()].reduce(
      (n, a) => n + a.length,
      0,
    )}`,
  );

  // Concurrent submissions fetches with a cache.
  const submissionsCache = new Map(); // paddedCik → candidates[] | null
  const ciks = [...cikTargets.keys()];
  const limitedCiks = LIMIT ? ciks.slice(0, LIMIT) : ciks;

  let fetched = 0;
  let fetchFailed = 0;
  async function worker(paddedCik) {
    if (submissionsCache.has(paddedCik)) return;
    const raw = await fetchSubmissions(paddedCik);
    if (!raw) {
      submissionsCache.set(paddedCik, null);
      fetchFailed++;
      return;
    }
    submissionsCache.set(paddedCik, candidatesFromSubmissions(raw));
    fetched++;
    if (fetched % 100 === 0) console.log(`  · fetched ${fetched}/${limitedCiks.length} CIKs`);
  }

  // Pool workers.
  let idx = 0;
  const runners = Array.from({ length: MAX_CONCURRENCY }, async () => {
    while (idx < limitedCiks.length) {
      const my = idx++;
      await worker(limitedCiks[my]);
    }
  });
  const t0 = Date.now();
  await Promise.all(runners);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nSubmissions fetched: ${fetched} · failed: ${fetchFailed} · elapsed ${dt}s`);

  // Match + rewrite.
  let upgraded = 0;
  let noMatch = 0;
  const dirtyShards = new Set();
  for (const [paddedCik, targets] of cikTargets) {
    const candidates = submissionsCache.get(paddedCik);
    if (!candidates || candidates.length === 0) {
      noMatch += targets.length;
      continue;
    }
    for (const { shard, ev, entity } of targets) {
      const match = matchAccession(ev, candidates);
      if (!match) {
        noMatch++;
        continue;
      }
      const url = buildAccessionUrl(paddedCik, match.accessionNumber, match.primaryDocument);
      const nextLink = { url, kind: "filing" };
      const cur = ev.sourceLink ?? null;
      if (cur && cur.url === nextLink.url && cur.kind === "filing") continue;
      ev.sourceLink = nextLink;
      dirtyShards.add(shard.file);
      upgraded++;
    }
  }

  // After counts.
  const after = { filing: 0, fallback: 0, none: 0 };
  for (const s of shards) {
    for (const ev of s.events) {
      const link = ev.sourceLink;
      if (!link) after.none++;
      else if (link.kind === "filing") after.filing++;
      else after.fallback++;
    }
  }

  console.log(`\nUpgraded to filing:  ${upgraded}`);
  console.log(`No accession match:  ${noMatch}`);
  console.log(`Shards dirty:        ${dirtyShards.size}`);
  console.log(
    `After:  filing=${after.filing} · fallback=${after.fallback} · none=${after.none}`,
  );
  console.log(
    `Δ:      filing ${before.filing}→${after.filing} (+${after.filing - before.filing})`,
  );

  if (DRY) {
    console.log("\nDry run — no write.");
    return;
  }

  // Write each dirty shard.
  for (const s of shards) {
    if (!dirtyShards.has(s.file)) continue;
    const body = s.isArray
      ? s.events
      : { ...s.parsed, events: s.events };
    await fs.writeFile(path.join(EVENTS_DIR, s.file), JSON.stringify(body, null, 2));
  }

  // Sync monolith if present locally (gitignored, optional).
  try {
    const monoRaw = await fs.readFile(EARNINGS, "utf-8");
    const mono = JSON.parse(monoRaw);
    let monoUpdates = 0;
    // Build a map from shards for O(1) lookup.
    const linkById = new Map();
    for (const s of shards) {
      for (const ev of s.events) {
        if (ev.sourceLink?.kind === "filing") linkById.set(ev.id, ev.sourceLink);
      }
    }
    for (const ev of mono.events ?? []) {
      const link = linkById.get(ev.id);
      if (!link) continue;
      const cur = ev.sourceLink;
      if (cur && cur.url === link.url && cur.kind === link.kind) continue;
      ev.sourceLink = link;
      monoUpdates++;
    }
    if (monoUpdates > 0) {
      await fs.writeFile(EARNINGS, JSON.stringify(mono, null, 2));
      console.log(`✓ patched monolith too (${monoUpdates} events)`);
    }
  } catch {
    // earnings.json is optional per CLAUDE.md.
  }

  console.log(`\n✓ wrote ${dirtyShards.size} shard(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
