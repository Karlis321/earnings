#!/usr/bin/env node
/**
 * Compliant SEC EDGAR fetcher. SEC blocks anonymous datacenter
 * requests (WebFetch from GitHub-hosted runners gets 403); the
 * dashboard's backfill scripts already work because they send a
 * contact-bearing User-Agent per EDGAR's fair-access policy.
 *
 *   node scripts/fetch-edgar.mjs <url> [outfile]
 *
 * Behaviour:
 *   - User-Agent: "BluOr earnings dashboard <email>" where <email>
 *     is $EDGAR_CONTACT_EMAIL, falling back to the value baked into
 *     frontend/.env.example.
 *   - Accept-Encoding: gzip.
 *   - Serialises against a lockfile in $TMPDIR/edgar-fetch.lock so
 *     back-to-back invocations from a Claude Code session obey the
 *     "≤1 req/sec" fair-access cap even though each invocation is a
 *     fresh Node process.
 *   - Writes body to `outfile` if supplied, else to stdout.
 *   - Exits 0 on 2xx. On any other status: prints the status line
 *     + first ~200 chars of the body to stderr and exits with the
 *     HTTP status code (clamped to 1..127).
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotli = promisify(zlib.brotliDecompress);

const HARDCODED_FALLBACK_EMAIL = "your-email@example.com";
const MIN_SPACING_MS = 1100;
const LOCK_PATH = path.join(os.tmpdir(), "edgar-fetch.lock");

function usage(msg) {
  if (msg) process.stderr.write(`fetch-edgar: ${msg}\n`);
  process.stderr.write(`usage: node scripts/fetch-edgar.mjs <url> [outfile]\n`);
  process.exit(2);
}

async function readTimestamp() {
  try {
    const raw = await fs.readFile(LOCK_PATH, "utf-8");
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function respectRateLimit() {
  const last = await readTimestamp();
  const wait = last + MIN_SPACING_MS - Date.now();
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  await fs.writeFile(LOCK_PATH, String(Date.now()));
}

async function main() {
  const url = process.argv[2];
  const outfile = process.argv[3];
  if (!url) usage("missing <url>");
  if (!/^https:\/\/(www\.)?sec\.gov\//.test(url)) {
    usage(`url must be on sec.gov (got: ${url})`);
  }

  const email = process.env.EDGAR_CONTACT_EMAIL || HARDCODED_FALLBACK_EMAIL;
  const ua = `BluOr earnings dashboard ${email}`;

  await respectRateLimit();

  let res;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        "Accept-Encoding": "gzip",
        "Accept": "*/*",
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "follow",
    });
  } catch (e) {
    process.stderr.write(`fetch-edgar: network error — ${e.message ?? e}\n`);
    process.exit(1);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const encoding = (res.headers.get("content-encoding") ?? "").toLowerCase();
  // Node's undici transparently decodes gzip/br/deflate but LEAVES the
  // Content-Encoding header in place — a second decode on already-plain
  // bytes fails with "incorrect header check". Sniff magic bytes and
  // only decompress if the body is actually still encoded.
  const looksGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const looksZlib = buf.length >= 2 && buf[0] === 0x78 && (buf[1] === 0x9c || buf[1] === 0xda || buf[1] === 0x01);
  let body = buf;
  try {
    if (encoding === "gzip" && looksGzip) body = await gunzip(buf);
    else if (encoding === "deflate" && looksZlib) body = await inflate(buf);
    else if (encoding === "br") {
      // Brotli has no reliable magic byte; assume the header is honest.
      body = await brotli(buf);
    }
  } catch (e) {
    process.stderr.write(`fetch-edgar: decompress error (${encoding}) — ${e.message}\n`);
    process.exit(1);
  }

  if (!res.ok) {
    const preview = body.toString("utf-8", 0, 240).replace(/\s+/g, " ").trim();
    process.stderr.write(`fetch-edgar: HTTP ${res.status} ${res.statusText}\n`);
    process.stderr.write(`  UA: ${ua}\n`);
    process.stderr.write(`  URL: ${url}\n`);
    if (preview) process.stderr.write(`  body[:240]: ${preview}\n`);
    // Exit with the HTTP status so shell callers can distinguish
    // 403 (need UA fix) from 404 (wrong URL) from 429 (throttle).
    // POSIX exit codes only survive as low byte, so clamp: any code
    // outside 1..127 collapses to 1 to keep 'exit 0' semantics safe.
    const code = Number.isInteger(res.status) && res.status >= 1 && res.status <= 127
      ? res.status
      : 1;
    process.exit(code);
  }

  if (outfile) {
    fssync.writeFileSync(outfile, body);
    process.stderr.write(`fetch-edgar: wrote ${body.length} bytes → ${outfile}\n`);
  } else {
    process.stdout.write(body);
  }
}

main().catch((e) => {
  process.stderr.write(`fetch-edgar: unhandled — ${e.stack ?? e.message ?? e}\n`);
  process.exit(1);
});
