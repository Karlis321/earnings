// Press-releases per-ticker fan-out.
// Ported from backend/reference/_officialSources.js (subset — edgar + rss only;
// mziq / html-abxx / html-shle skipped for now).
//
// Sources come from two places:
//   1. `OFFICIAL_SOURCES[ticker]` below — hand-curated IR-page RSS feeds
//      (impossible to auto-derive since IR-page RSS URLs aren't discoverable
//      programmatically).
//   2. The entity's stored `edgarCik` — resolved automatically at add-ticker
//      time via SEC's public ticker→CIK JSON. This is the auto-populated
//      path for new tickers; no hand-editing needed for any SEC filer
//      (US-listed or 20-F/40-F foreign filer).

import { store } from "@/server/store";
import { resolveEdgarCik } from "@/server/lib/edgarCikResolver";
import type { Entity } from "@/lib/types";

const EDGAR = (cik: string) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40&output=atom`;

const NEWSFILE = (id: string) => `https://feeds.newsfilecorp.com/company/${id}`;

interface OfficialSource {
  kind: "edgar" | "rss";
  url: string;
  provenance: "regulatory" | "ir-page" | "wire";
  label: string;
}

export const OFFICIAL_SOURCES: Record<string, OfficialSource[]> = {
  "INTC US": [
    { kind: "edgar", url: EDGAR("0000050863"), provenance: "regulatory", label: "SEC EDGAR" },
  ],
  "NVDA US": [
    { kind: "edgar", url: EDGAR("0001045810"), provenance: "regulatory", label: "SEC EDGAR" },
  ],
  "BN US": [
    { kind: "edgar", url: EDGAR("0001001085"), provenance: "regulatory", label: "SEC EDGAR" },
  ],
  "CENX US": [
    { kind: "rss", url: "https://centuryaluminum.com/RSS/PressRelease.aspx", provenance: "ir-page", label: "Investor Relations" },
    { kind: "edgar", url: EDGAR("0000949157"), provenance: "regulatory", label: "SEC EDGAR" },
  ],
  "CCJ US": [
    { kind: "edgar", url: EDGAR("0001064728"), provenance: "regulatory", label: "SEC EDGAR" },
  ],
  "ABXX CN": [
    // Abaxx Technologies is Canadian-listed (NEO/TSX). Publishes via
    // Newsfile — update once we confirm their exact feed ID.
    // Placeholder: no auto-fetch until an official-sources entry lands.
  ],
  "SHLE US": [
    // Silver Horn Lithium not on EDGAR/OTC feeds we can reach; leave empty.
  ],
  "HBM US": [
    { kind: "rss", url: "https://hudbayminerals.com/rss/PressRelease.aspx", provenance: "ir-page", label: "Investor Relations" },
    { kind: "edgar", url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001322520&type=&dateb=&owner=include&count=40&output=atom", provenance: "regulatory", label: "SEC EDGAR" },
  ],
  "CS CN": [
    { kind: "rss", url: "https://capstonecopper.com/feed/", provenance: "ir-page", label: "Investor Relations" },
  ],
  "TGB CN": [
    { kind: "edgar", url: EDGAR("0000878518"), provenance: "regulatory", label: "SEC EDGAR (US filings)" },
  ],
  "SCMI CN": [
    { kind: "rss", url: NEWSFILE("11605"), provenance: "wire", label: "Newsfile" },
  ],
  "SILV CN": [
    { kind: "rss", url: "https://silvercrestmetals.com/feed/", provenance: "ir-page", label: "Investor Relations" },
  ],
  "RIO PA": [
    // Rio Tinto files 20-F with SEC
    { kind: "edgar", url: EDGAR("0000863064"), provenance: "regulatory", label: "SEC EDGAR" },
  ],
  "NOK FH": [
    { kind: "edgar", url: EDGAR("0000924613"), provenance: "regulatory", label: "SEC EDGAR (20-F filer)" },
  ],
  // Non-SEC filers — verified IR-page RSS feeds. Auto-CIK resolver
  // returns null for these; hand-added here since IR-page URLs aren't
  // discoverable programmatically.
  "TOI CN": [
    { kind: "rss", url: "https://topicus.com/rss", provenance: "ir-page", label: "Topicus IR" },
  ],
  "DBG CN": [
    { kind: "rss", url: "https://www.doubleview.ca/feed/", provenance: "ir-page", label: "Doubleview Gold IR" },
  ],
  "VLE CN": [
    { kind: "rss", url: "https://www.valeuraenergy.com/feed/", provenance: "ir-page", label: "Valeura Energy IR" },
  ],
};

const UA_EDGAR = "Earnings Tracker (contact@example.com)";
const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

export interface PressReleaseItem {
  headline: string;
  url: string;
  source: string;
  provenance: "regulatory" | "ir-page" | "wire";
  time: string | null;
  kind: "edgar" | "rss";
}

async function fetchAtomOrRss(
  url: string,
  isEdgar: boolean,
): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": isEdgar ? UA_EDGAR : UA_BROWSER,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

// EDGAR feeds are Atom; entry title includes the form-type e.g.
// "10-K - Annual Report - Filing (2025-02-13)".
function parseAtom(xml: string, source: OfficialSource): PressReleaseItem[] {
  const items: PressReleaseItem[] = [];
  const matches = xml.match(/<entry[\s\S]*?<\/entry>/g) ?? [];
  for (const block of matches.slice(0, 20)) {
    const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const linkM = block.match(/<link[^>]*href="([^"]+)"/);
    const updM =
      block.match(/<updated>([\s\S]*?)<\/updated>/) ??
      block.match(/<published>([\s\S]*?)<\/published>/);
    if (!titleM || !linkM) continue;
    const title = decodeEntities(
      titleM[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim(),
    );
    // EDGAR: skip everything except material forms
    if (
      source.kind === "edgar" &&
      !/^(?:8-K|10-K|10-Q|6-K|20-F|40-F|DEF 14A|PRE 14A|425|S-1|F-1|S-3|F-3)/.test(
        title,
      )
    ) {
      continue;
    }
    let time: string | null = null;
    if (updM) {
      try {
        time = new Date(updM[1].trim()).toISOString();
      } catch {
        /* leave null */
      }
    }
    items.push({
      headline: title,
      url: decodeEntities(linkM[1]),
      source: source.label,
      provenance: source.provenance,
      time,
      kind: source.kind,
    });
  }
  return items;
}

function parseRss(xml: string, source: OfficialSource): PressReleaseItem[] {
  const items: PressReleaseItem[] = [];
  const matches = xml.match(/<item[\s\S]*?<\/item>/g) ?? [];
  for (const block of matches.slice(0, 20)) {
    const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const linkM =
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/) ??
      block.match(/<link[^>]*href="([^"]+)"/);
    const dateM =
      block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ??
      block.match(/<dc:date>([\s\S]*?)<\/dc:date>/);
    if (!titleM || !linkM) continue;
    const title = decodeEntities(
      titleM[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim(),
    );
    const url = decodeEntities(linkM[1].trim());
    if (!url || url.startsWith("<")) continue;
    let time: string | null = null;
    if (dateM) {
      try {
        time = new Date(dateM[1].trim()).toISOString();
      } catch {
        /* leave null */
      }
    }
    items.push({
      headline: title,
      url,
      source: source.label,
      provenance: source.provenance,
      time,
      kind: source.kind,
    });
  }
  return items;
}

export interface PressReleasesResult {
  ticker: string;
  fetchedAt: string;
  items: PressReleaseItem[];
  engineStatus: Array<{
    label: string;
    kind: "edgar" | "rss";
    ok: boolean;
    itemsFound: number;
  }>;
}

// Merge the hand-curated OFFICIAL_SOURCES with a dynamic EDGAR entry
// synthesized from the registry entity's `edgarCik`. If the entity has no
// stored CIK but the ticker looks like an SEC filer, resolve on-the-fly
// against SEC's public JSON so newly added tickers work without a cron
// pass first. Registry write for missing CIKs happens in cron so we don't
// race two `fetchPressReleases` calls into concurrent commits here.
async function resolveSourcesForTicker(
  ticker: string,
): Promise<OfficialSource[]> {
  const curated = OFFICIAL_SOURCES[ticker] ?? [];
  const hasCuratedEdgar = curated.some((s) => s.kind === "edgar");
  if (hasCuratedEdgar) return curated;

  let entity: Entity | undefined;
  try {
    const registry = await store.readRegistry();
    entity = registry.find((e) => e.ticker === ticker);
  } catch {
    return curated;
  }
  if (!entity) return curated;

  let cik = entity.edgarCik;
  if (cik === undefined) {
    try {
      cik = await resolveEdgarCik({
        ticker: entity.ticker,
        legalName: entity.legalName,
      });
    } catch {
      cik = null;
    }
  }
  if (!cik) return curated;

  return [
    ...curated,
    {
      kind: "edgar",
      url: EDGAR(cik),
      provenance: "regulatory",
      label: "SEC EDGAR",
    },
  ];
}

export async function fetchPressReleases(
  ticker: string,
): Promise<PressReleasesResult> {
  const sources = await resolveSourcesForTicker(ticker);
  const results = await Promise.all(
    sources.map(async (src) => {
      const xml = await fetchAtomOrRss(src.url, src.kind === "edgar");
      if (xml === null) {
        return { src, ok: false as const, items: [] as PressReleaseItem[] };
      }
      const items =
        src.kind === "edgar" ? parseAtom(xml, src) : parseRss(xml, src);
      return { src, ok: true as const, items };
    }),
  );
  const allItems = results.flatMap((r) => r.items);
  allItems.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
  return {
    ticker,
    fetchedAt: new Date().toISOString(),
    items: allItems.slice(0, 30),
    engineStatus: results.map((r) => ({
      label: r.src.label,
      kind: r.src.kind,
      ok: r.ok,
      itemsFound: r.items.length,
    })),
  };
}
