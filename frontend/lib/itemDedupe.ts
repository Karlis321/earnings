// Dedupe helper used by the refresh-sources orchestrator.
//
// Two-pass:
//   1. URL — strip query string + fragment, lowercase host+path.
//   2. Normalized headline — strip trailing "— Publisher", strip punctuation,
//      drop stopwords, sort remaining words. Catches syndicated pieces
//      where five publishers rewrote the same wire story with slight
//      punctuation and word-order differences.
//
// Deterministic item.id (`urlHash`) so a repeat POST /events/:id/append-sources
// is a no-op (append-sources also dedupes at the store layer by id).

import type { SourceItem } from "@/lib/types";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "for",
  "to", "from", "by", "with", "as", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "this",
  "that", "these", "those", "it", "its", "s",
]);

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Drop tracking params and fragment; preserve path.
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url.split("#")[0].split("?")[0].toLowerCase().replace(/\/$/, "");
  }
}

export function normalizeHeadline(headline: string): string {
  // Drop trailing " — Publisher" / " - Publisher" / " | Publisher"
  const stripped = headline.replace(/\s+[—\-|]\s+[^—\-|]+$/, "");
  const words = stripped
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return words.sort().join(" ");
}

// Deterministic 32-bit FNV-1a hash → 8-char base36 string.
export function urlHash(url: string): string {
  const s = normalizeUrl(url);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0").slice(0, 8);
}

// Dedupes a merged item list. First-wins order — pass items with highest
// provenance quality first (regulatory → wire → news → social).
export function dedupeItems(items: SourceItem[]): SourceItem[] {
  const seenUrl = new Set<string>();
  const seenHeadline = new Set<string>();
  const out: SourceItem[] = [];
  for (const it of items) {
    const uKey = normalizeUrl(it.url);
    if (seenUrl.has(uKey)) continue;
    const hKey = normalizeHeadline(it.headline);
    if (hKey && seenHeadline.has(hKey)) continue;
    seenUrl.add(uKey);
    if (hKey) seenHeadline.add(hKey);
    out.push(it);
  }
  return out;
}
