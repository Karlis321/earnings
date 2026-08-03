#!/usr/bin/env node
/**
 * Prime Yahoo crumb + cookie ONCE per orchestrator run, write to
 * /tmp/yahoo-crumb.json so subsequent scripts (refresh-yahoo-shards,
 * ingest-eps-estimates, mature-any-reported, mature-stale-upcoming,
 * ingest-estimates-universe, mature-reactions, refresh-marketcap)
 * read from cache instead of re-priming.
 *
 * Motivation: on GitHub Actions Ubuntu, Yahoo's fc.yahoo.com endpoint
 * intermittently returns empty Set-Cookie or non-2xx on getcrumb from
 * datacenter IPs. If N scripts each prime N times, rapid retry loops
 * from the same IP tip Yahoo into a soft-block. First refresh-data.yml
 * run had 3 crumb-prime failures; second had 4 (mature-reported /
 * mature-stale / trend-estimates / marketcap). Shared cache reduces
 * the crumb-prime attempt count from ~7 (per Yahoo-using script) to
 * 1 per run.
 *
 * Cache TTL: 55 min (Yahoo's crumb typically valid ~1h).
 *
 *   node scripts/prime-yahoo-crumb.mjs
 *   node scripts/prime-yahoo-crumb.mjs --dry-run   # just probe, don't write
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const CACHE_PATH = path.join(os.tmpdir(), "yahoo-crumb.json");

async function tryPrime() {
  try {
    const r1 = await fetch("https://fc.yahoo.com/", {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const hdrs = r1.headers;
    const setCookies = typeof hdrs.getSetCookie === "function"
      ? hdrs.getSetCookie()
      : (hdrs.get("set-cookie") ? [hdrs.get("set-cookie")] : []);
    const pairs = new Map();
    for (const raw of setCookies) {
      const f = raw.split(";", 1)[0].trim();
      const eq = f.indexOf("=");
      if (eq > 0) pairs.set(f.slice(0, eq), f.slice(eq + 1));
    }
    const cookie = [...pairs].map(([n, v]) => `${n}=${v}`).join("; ");
    if (!cookie) return null;
    const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: cookie, Accept: "text/plain" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r2.ok) return null;
    const crumb = (await r2.text()).trim();
    if (!crumb || /Unauthorized|<html/i.test(crumb)) return null;
    return { crumb, cookie };
  } catch { return null; }
}

async function main() {
  // 5 attempts × 3s backoff. Longer + wider than the per-script
  // retry — this is the ONE crumb prime for the whole run so it's
  // worth the extra patience.
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`  attempt ${attempt}/5 · ${new Date().toISOString().slice(11, 19)}Z`);
    const state = await tryPrime();
    if (state) {
      console.log(`  ✓ got crumb ${state.crumb.slice(0, 6)}… (${state.cookie.length} bytes cookie)`);
      if (!DRY) {
        await fs.writeFile(CACHE_PATH, JSON.stringify({
          crumb: state.crumb,
          cookie: state.cookie,
          expiresAt: Date.now() + 55 * 60_000,
          primedAt: new Date().toISOString(),
        }));
        console.log(`  ✓ cached → ${CACHE_PATH}`);
      }
      return;
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 3000));
  }
  console.error(`::error::prime-yahoo-crumb failed after 5 attempts — Yahoo may be blocking this runner IP.`);
  console.error(`  Downstream Yahoo-using phases will each try their own retry loop as a fallback.`);
  // Exit 0 (not 1) — we don't want to fail the whole orchestrator
  // just because Yahoo is temporarily unreachable. Individual scripts
  // still have their own retry logic.
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(0); });
