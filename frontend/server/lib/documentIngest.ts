// Document ingestion pipeline: raw HTML → sanitized, anchor-injected,
// transcript-segmented Document ready for hosted-mode rendering.
//
// Sanitizer rules (from W7 plan):
//   allow: <a href|rel|target>, <section id>, <h1..h6>, <p>, <strong>, <em>,
//          <ul>, <ol>, <li>, <br>, <hr>, <blockquote>, <code>, <pre>,
//          <span>, <table>, <thead>, <tbody>, <tfoot>, <tr>, <td>, <th>
//   strip: <script>, <style>, <iframe>, <object>, <embed>, <form>, <noscript>,
//          <link>, <meta>, event handlers, javascript: URLs
// Anchor injection: every content paragraph is wrapped in <section id="para-N">.
// Transcript segmentation: Motley Fool / Seeking Alpha / company-native
// speaker markers → TranscriptSegment[]. Fails soft to a single unknown segment.

import type {
  Document,
  DocumentKind,
  DocumentMeta,
  Provenance,
  TranscriptSegment,
} from "@/lib/types";
import { urlHash } from "@/lib/itemDedupe";

const ALLOWED_TAGS = new Set([
  "a", "section", "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "strong", "em", "b", "i", "u",
  "ul", "ol", "li", "br", "hr", "blockquote", "code", "pre",
  "span", "div",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
]);
// Per-tag attribute allowlist. Attributes not listed here are stripped.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "title"]),
  section: new Set(["id"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};

// ---------- Sanitizer ----------

function stripBlocks(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[^>]*>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<link[^>]*>/gi, "")
    .replace(/<meta[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function stripEventHandlers(tag: string): string {
  return tag
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
}

// Filter attributes to the per-tag allowlist; block javascript: URLs on href.
function filterAttrs(tagName: string, attrs: string): string {
  const allow = ALLOWED_ATTRS[tagName] ?? new Set<string>();
  const out: string[] = [];
  // Match name="value" or name='value' or name=value or bare boolean
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    const name = m[1].toLowerCase();
    if (!allow.has(name)) continue;
    let value = m[2];
    // Unquote to check value
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (name === "href" && /^\s*javascript:/i.test(value)) continue;
    // Normalize to quoted form
    out.push(`${name}="${value.replace(/"/g, "&quot;")}"`);
  }
  return out.length ? " " + out.join(" ") : "";
}

// Rewrite <tag [attrs]> and </tag> — drop disallowed tags entirely (keep
// their inner text so we don't lose content).
function sanitizeTags(html: string): string {
  // Handle end tags first: </tag>
  let out = html.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/g, (_, name) => {
    return ALLOWED_TAGS.has(name.toLowerCase()) ? `</${name.toLowerCase()}>` : "";
  });
  // Start tags and self-closing tags
  out = out.replace(
    /<([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g,
    (_, rawName, rawAttrs, selfClose) => {
      const name = rawName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return "";
      const cleanedAttrs = filterAttrs(name, stripEventHandlers(rawAttrs));
      return `<${name}${cleanedAttrs}${selfClose ? "/" : ""}>`;
    },
  );
  return out;
}

export function sanitizeHtml(raw: string): string {
  return sanitizeTags(stripBlocks(raw));
}

// ---------- Body extraction ----------

function extractBody(html: string): string {
  // Prefer <article>, then <main>, then <body>. Fall back to full document.
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (article) return article[1];
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1];
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (body) return body[1];
  return html;
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) return decodeEntities(titleMatch[1].trim());
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return decodeEntities(stripTags(h1[1]).trim());
  return "Untitled";
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
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

// ---------- Anchor injection ----------

// Wrap every top-level <p> in <section id="para-N">. Also promote headings
// to their own sections so anchors can target section headers.
export function injectParagraphAnchors(bodyHtml: string): {
  html: string;
  count: number;
} {
  let i = 0;
  const wrap = (inner: string) => {
    i++;
    return `<section id="para-${i}">${inner}</section>`;
  };
  const html = bodyHtml.replace(
    /<(p|h[1-6]|blockquote|pre)([^>]*)>([\s\S]*?)<\/\1>/gi,
    (_full, tag, attrs, inner) => {
      return wrap(`<${tag.toLowerCase()}${attrs}>${inner}</${tag.toLowerCase()}>`);
    },
  );
  return { html, count: i };
}

// ---------- Content hash ----------

export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let j = 0; j < s.length; j++) {
    h ^= s.charCodeAt(j);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

// ---------- Transcript segmentation ----------

// Heuristic segmentation: search paragraphs for known speaker markers.
// Motley Fool: paragraph starts with "<strong>Name -- Role</strong>"
// Seeking Alpha: preceded by <h4>Name</h4>
// Company-native: <p><b>Name:</b> …
// Prepared/Q&A split: paragraph containing "Prepared Remarks" or
// "Question-and-Answer" (case-insensitive) flips subsequent role.
export function segmentTranscript(html: string): TranscriptSegment[] {
  const paraRe = /<section id="para-(\d+)">([\s\S]*?)<\/section>/gi;
  const paras: Array<{ id: string; text: string; html: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(html)) !== null) {
    paras.push({ id: `para-${m[1]}`, html: m[2], text: stripTags(m[2]).trim() });
  }
  if (paras.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  let role: TranscriptSegment["role"] = "unknown";
  let currentSpeaker: string | null = null;
  let currentIds: string[] = [];
  let segIdx = 0;

  const flush = () => {
    if (currentIds.length === 0) return;
    segIdx++;
    segments.push({
      id: `seg-${segIdx}`,
      speaker: currentSpeaker,
      role,
      paragraphIds: currentIds.slice(),
    });
    currentIds = [];
  };

  const speakerRe =
    /^\s*(?:<strong>|<b>)\s*([A-Z][A-Za-z.\-'\s]{1,60}?)(?:\s*--\s*[^<]+)?\s*(?:<\/strong>|<\/b>)\s*[:.]?/;

  for (const p of paras) {
    // Role transitions
    if (/prepared\s+remarks/i.test(p.text)) {
      flush();
      role = "prepared";
      currentSpeaker = null;
      currentIds = [p.id];
      continue;
    }
    if (/question[-\s]?and[-\s]?answer|q&a\s+session/i.test(p.text)) {
      flush();
      role = "qa";
      currentSpeaker = null;
      currentIds = [p.id];
      continue;
    }
    // Speaker line
    const s = p.html.match(speakerRe);
    if (s) {
      flush();
      currentSpeaker = s[1].trim();
      currentIds = [p.id];
    } else {
      currentIds.push(p.id);
    }
  }
  flush();
  return segments;
}

// ---------- Kind detection ----------

function detectKind(url: string, sanitized: string): DocumentKind {
  const host = safeHost(url);
  if (/sec\.gov/i.test(host)) return "filing";
  if (/newsfilecorp\.com/i.test(host)) return "press-release";
  if (/fool\.com|seekingalpha\.com/i.test(host)) return "transcript";
  if (/prepared remarks|earnings conference call|q&a session/i.test(sanitized)) {
    return "transcript";
  }
  return "article";
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

// ---------- End-to-end ingestion ----------

export interface IngestInput {
  url: string;
  rawHtml: string;
  provenance: Provenance;
  source: string; // display label, e.g. "SEC EDGAR"
  language?: string;
  publishedAt?: string | null;
  priorVersion?: number; // for re-ingest bumping
  priorHash?: string;
}

// Hosts we're willing to fetch + ingest server-side. Kept narrow: analyst
// clicks routinely land on EDGAR / IR press pages, and those hosts are
// generally friendly to server-side fetches with a UA. Extend after
// confirming a host's terms allow re-serving sanitized content.
export const INGESTABLE_HOSTS: Set<string> = new Set([
  // Regulatory
  "www.sec.gov",
  "sec.gov",
  "www.federalreserve.gov",
  "federalreserve.gov",
  "www.ecb.europa.eu",
  "ecb.europa.eu",
  "www.bankofengland.co.uk",
  // Company IR sites (individually vetted — extend only after
  // confirming a host serves clean press-release HTML)
  "capstonecopper.com",
  "www.capstonecopper.com",
  "hudbayminerals.com",
  "www.hudbayminerals.com",
  "centuryaluminum.com",
  "www.centuryaluminum.com",
  "silvercrestmetals.com",
  "www.silvercrestmetals.com",
  // Wire services — designed for redistribution, so safe defaults for
  // any ticker whose press releases route through these hosts.
  "www.newsfilecorp.com",
  "newsfilecorp.com",
  "feeds.newsfilecorp.com",
  "www.globenewswire.com",
  "globenewswire.com",
  "www.prnewswire.com",
  "prnewswire.com",
  "www.newswire.ca",
  "newswire.ca",
  "www.businesswire.com",
  "businesswire.com",
  "www.accesswire.com",
  "accesswire.com",
  // Yahoo Finance — earnings source URLs in past-event Facts point here.
  // The article shell is thin (mostly JS-shimmed) but the sanitizer
  // handles it cleanly and the source link stays traceable.
  "finance.yahoo.com",
]);

export function isIngestableUrl(url: string): boolean {
  const h = safeHost(url);
  return INGESTABLE_HOSTS.has(h);
}

export function ingestDocument(input: IngestInput): {
  document: Document;
  changed: boolean;
} {
  const sanitized = sanitizeHtml(extractBody(input.rawHtml));
  const { html: bodyWithAnchors, count } = injectParagraphAnchors(sanitized);
  const hash = contentHash(bodyWithAnchors);
  const changed = hash !== input.priorHash;
  const kind = detectKind(input.url, sanitized);
  const segments = kind === "transcript" ? segmentTranscript(bodyWithAnchors) : [];
  const now = new Date().toISOString();
  const meta: DocumentMeta = {
    id: urlHash(input.url),
    url: input.url,
    title: extractTitle(input.rawHtml),
    publishedAt: input.publishedAt ?? null,
    source: input.source,
    provenance: input.provenance,
    language: input.language ?? "en",
    fetchedAt: now,
    ingestVersion: changed ? (input.priorVersion ?? 0) + 1 : (input.priorVersion ?? 1),
    sourceContentHash: hash,
    kind,
    paragraphCount: count,
    segments,
  };
  return {
    document: { schema: "document/v1", meta, html: bodyWithAnchors },
    changed,
  };
}

// End-to-end fetch + ingest + persist for a single URL. Used by the cron
// (server-side) to auto-ingest press-release URLs on the allowlist.
// Returns a rich result the cron can roll up into CronRunSummary.
const CRON_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

export interface FetchAndIngestInput {
  url: string;
  provenance: Provenance;
  source: string;
  language?: string;
  publishedAt?: string | null;
  timeoutMs?: number;
}

export interface FetchAndIngestResult {
  id: string;
  url: string;
  ok: boolean;
  changed: boolean;
  ingestVersion: number;
  kind: DocumentKind | null;
  paragraphCount: number;
  error?: string;
}

export async function fetchAndIngest(
  input: FetchAndIngestInput,
  storeRead: (id: string) => Promise<Document | null>,
  storeWrite: (doc: Document) => Promise<void>,
): Promise<FetchAndIngestResult> {
  const id = urlHash(input.url);
  try {
    const r = await fetch(input.url, {
      headers: {
        "User-Agent": CRON_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(input.timeoutMs ?? 12_000),
    });
    if (!r.ok) {
      return {
        id,
        url: input.url,
        ok: false,
        changed: false,
        ingestVersion: 0,
        kind: null,
        paragraphCount: 0,
        error: `${r.status}`,
      };
    }
    const raw = await r.text();
    const existing = await storeRead(id);
    const { document, changed } = ingestDocument({
      url: input.url,
      rawHtml: raw,
      provenance: input.provenance,
      source: input.source,
      language: input.language ?? "en",
      publishedAt: input.publishedAt ?? null,
      priorVersion: existing?.meta.ingestVersion,
      priorHash: existing?.meta.sourceContentHash,
    });
    // Skip the write when hash matches — cron stays a no-op on replay.
    if (!changed && existing) {
      return {
        id,
        url: input.url,
        ok: true,
        changed: false,
        ingestVersion: existing.meta.ingestVersion,
        kind: existing.meta.kind,
        paragraphCount: existing.meta.paragraphCount,
      };
    }
    await storeWrite(document);
    return {
      id,
      url: input.url,
      ok: true,
      changed: true,
      ingestVersion: document.meta.ingestVersion,
      kind: document.meta.kind,
      paragraphCount: document.meta.paragraphCount,
    };
  } catch (e) {
    return {
      id,
      url: input.url,
      ok: false,
      changed: false,
      ingestVersion: 0,
      kind: null,
      paragraphCount: 0,
      error: (e as Error).message,
    };
  }
}
