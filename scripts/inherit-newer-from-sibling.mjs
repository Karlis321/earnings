#!/usr/bin/env node
/**
 * Targeted top-up of stale shards from a fresher companyId sibling.
 *
 * Complements scripts/inherit-from-siblings.mjs (which only fills
 * empty shards). This one takes a { target, sibling } pair list,
 * copies over events from sibling that have eventDate > target's
 * latest, rewrites ticker + eventId to the target's namespace,
 * and merges into target's shard. Currency/unit strings are left
 * alone — SEC-verbatim rule already ensures financial metric values
 * are shared across listings; the ADR just needs the timeline.
 *
 * Usage:
 *   node scripts/inherit-newer-from-sibling.mjs --pairs="TGT1:SIB1,TGT2:SIB2" [--dry]
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "data", "events");
const OUT_DIR = path.join(ROOT, "scripts", "audits");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY = args.get("dry") === true;
const PAIRS = String(args.get("pairs") ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => {
    const [target, sibling] = p.split(":");
    return { target: target.trim(), sibling: sibling.trim() };
  });

function tickerSlug(t) {
  return t.replace(/\s+/g, "_").replace(/[^A-Z0-9_.-]/gi, "_");
}
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}
function readShard(t) {
  const p = path.join(EVENTS_DIR, tickerSlug(t) + ".json");
  try {
    const raw = JSON.parse(fssync.readFileSync(p, "utf-8"));
    const events = Array.isArray(raw) ? raw : raw.events ?? [];
    return { path: p, raw, events };
  } catch {
    return null;
  }
}

async function main() {
  if (PAIRS.length === 0) {
    console.error("no --pairs given · e.g. --pairs=\"SFTBF US:9984 JP,HLN US:HLN LN\"");
    process.exit(1);
  }
  const audit = { generatedAt: new Date().toISOString(), dry: DRY, results: [] };
  const today = new Date().toISOString().slice(0, 10);

  for (const { target, sibling } of PAIRS) {
    const tgtBox = readShard(target);
    const sibBox = readShard(sibling);
    if (!tgtBox) {
      audit.results.push({ target, sibling, ok: false, reason: "target_shard_missing" });
      continue;
    }
    if (!sibBox) {
      audit.results.push({ target, sibling, ok: false, reason: "sibling_shard_missing" });
      continue;
    }
    const tgtPast = tgtBox.events
      .filter((e) => e.eventDate && e.eventDate <= today)
      .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
    const tgtLatestDate = tgtPast[0]?.eventDate ?? "0000-00-00";

    const newerFromSibling = sibBox.events.filter(
      (e) => e.eventDate && e.eventDate > tgtLatestDate && e.eventDate <= today,
    );
    if (newerFromSibling.length === 0) {
      audit.results.push({ target, sibling, ok: true, added: 0, reason: "sibling_not_fresher" });
      continue;
    }

    // Clone each newer event with rewritten ticker + fresh eventId.
    // Metrics stay as-is (SEC-verbatim ensures values are shared
    // across listings — no per-listing translation needed).
    const cloned = newerFromSibling.map((e) => ({
      ...e,
      ticker: target,
      eventId: hashId(`${target}::${e.period ?? e.eventDate}`),
      // Preserve the provenance chain; note the inheritance origin.
      inheritedFrom: sibling,
    }));

    const combined = [...tgtBox.events, ...cloned].sort((a, b) => {
      const da = a.eventDate ?? a.scheduledDate ?? "";
      const db = b.eventDate ?? b.scheduledDate ?? "";
      return db.localeCompare(da);
    });

    const wrapper = Array.isArray(tgtBox.raw)
      ? combined
      : { ...tgtBox.raw, events: combined };

    if (!DRY) {
      await fs.writeFile(tgtBox.path, JSON.stringify(wrapper, null, 2));
    }

    audit.results.push({
      target,
      sibling,
      ok: true,
      added: cloned.length,
      newest: cloned[0]?.eventDate ?? null,
      prev_target_latest: tgtLatestDate,
    });
    console.log(
      `${target.padEnd(10)} ← ${sibling.padEnd(10)} · +${cloned.length} events · newest ${cloned[0]?.eventDate ?? "?"} (was ${tgtLatestDate})`,
    );
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "inherit-newer-from-sibling.json"),
    JSON.stringify(audit, null, 2),
  );
  console.log(`\n✓ audit → scripts/audits/inherit-newer-from-sibling.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
