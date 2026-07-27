// Shared ticker matcher — ported from backend/reference/_tickerMatch.js.
// Used by the tweet path to filter TwitterAPI.io hits down to items that
// actually reference the holding (not just a name collision), and by the
// news orchestrator to drop off-topic Google-News hits.

import type { Entity } from "@/lib/types";

const MIN_ALIAS_LEN = 3;
const CN_SUFFIXES = ["TO", "V", "NE", "VN", "CN"];

function escapeRegex(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBloomberg(ticker: string): { base: string; exchange: string } | null {
  const m = ticker.trim().match(/^([A-Z0-9]+)\s+(US|CN|PA|FH|LN|AU|JP|HK|SW)$/i);
  if (!m) return null;
  return { base: m[1].toUpperCase(), exchange: m[2].toUpperCase() };
}

// True if `text` mentions the holding by name / alias / cashtag / Yahoo suffix.
// Short alphabetic aliases (2–5 chars) use word-boundary matching so "BAM"
// doesn't collide with "Bambi". Longer aliases use plain substring.
export function mentionsHolding(text: string, entity: Entity): boolean {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();

  const aliases = collectAliases(entity);
  for (const a of aliases) {
    if (a.length < MIN_ALIAS_LEN) continue;
    if (/^[A-Za-z]{2,5}$/.test(a)) {
      const re = new RegExp(`\\b${escapeRegex(a)}\\b`, "i");
      if (re.test(text)) return true;
    } else if (lower.includes(a.toLowerCase())) {
      return true;
    }
  }

  const parsed = parseBloomberg(entity.ticker);
  if (!parsed) return false;
  const { base, exchange } = parsed;

  const cashRe = new RegExp(`\\$${escapeRegex(base)}\\b`, "i");
  if (cashRe.test(text)) return true;

  if (exchange === "CN") {
    const suffixGroup = CN_SUFFIXES.map(escapeRegex).join("|");
    const suffixRe = new RegExp(
      `\\$?${escapeRegex(base)}\\.(?:${suffixGroup})\\b`,
      "i",
    );
    if (suffixRe.test(text)) return true;
  }
  return false;
}

// Drops items that match any exclusion alias regardless of a positive
// mention. Fixes the "Hoya Capital REIT" ↔ "HOYA Corp" style collisions.
export function matchesExclusionAlias(text: string, entity: Entity): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return entity.exclusionAliases.some((a) => a && lower.includes(a.toLowerCase()));
}

export function collectAliases(entity: Entity): string[] {
  const out = new Set<string>();
  if (entity.displayName) out.add(entity.displayName.trim());
  if (entity.legalName) out.add(entity.legalName.trim());
  for (const a of entity.aliases) {
    if (a?.trim()) out.add(a.trim());
  }
  return Array.from(out);
}

// Tokens to feed a third-party search API (e.g. TwitterAPI.io advanced_search).
// Excludes overly-generic aliases (< MIN_ALIAS_LEN). Includes cashtag +
// Yahoo-suffix forms for Canadian listings.
export function tickerSearchTokens(entity: Entity): string[] {
  const tokens = new Set<string>();
  for (const a of collectAliases(entity)) {
    if (a.length >= MIN_ALIAS_LEN) tokens.add(a);
  }
  if (entity.cashtag) tokens.add(`$${entity.cashtag}`);
  const parsed = parseBloomberg(entity.ticker);
  if (parsed) {
    tokens.add(`$${parsed.base}`);
    if (parsed.exchange === "CN") {
      for (const sfx of CN_SUFFIXES) tokens.add(`${parsed.base}.${sfx}`);
    }
  }
  return Array.from(tokens);
}
