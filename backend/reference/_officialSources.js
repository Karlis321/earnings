// Per-holding registry of OFFICIAL press-release & regulatory-filing feeds.
// Used by /api/press-releases and /api/must-reads.
//
// File is prefixed with `_` so Vercel does NOT expose it as an HTTP endpoint.
//
// Every URL here is a primary publication channel for the issuer itself —
// either the company's own IR-page RSS, its SEC filings on EDGAR, or its
// chosen PR-wire vendor (Newsfile). Aggregators (Yahoo Finance, Google News
// syndication, etc.) are deliberately NOT used as a source for the "Official
// press releases" filter — anything that originated upstream of the issuer
// is editorial coverage, not a press release.
//
// Source shape:
//   {
//     kind:        'edgar' | 'rss'
//     url:         string                              // feed URL (Atom or RSS 2.0)
//     provenance:  'regulatory' | 'ir-page' | 'wire'   // shown in the UI chip
//     label:       string                              // human-readable source label
//     translate?:  'pt-en'                             // non-English feed: ask Claude to translate at enrich
//   }
//
// All URLs verified live 2026-05-19. Verification rule: HTTP 200, valid
// XML, at least one item dated within the past 12 months.

const EDGAR = (cik) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40&output=atom`;

const NEWSFILE = (id) => `https://feeds.newsfilecorp.com/company/${id}`;

export const OFFICIAL_SOURCES = {
  // ============================================================
  // US-listed
  // ============================================================
  'BN US': [
    { kind: 'edgar', url: EDGAR('0001001085'), provenance: 'regulatory', label: 'SEC EDGAR' },
  ],

  'CENX US': [
    { kind: 'rss',   url: 'https://centuryaluminum.com/RSS/PressRelease.aspx', provenance: 'ir-page',    label: 'Investor Relations' },
    { kind: 'edgar', url: EDGAR('0000949157'),                                 provenance: 'regulatory', label: 'SEC EDGAR' },
  ],

  'HBM US': [
    { kind: 'rss',   url: 'https://hudbayminerals.com/rss/PressRelease.aspx', provenance: 'ir-page',    label: 'Investor Relations' },
    { kind: 'edgar', url: EDGAR('0001322422'),                                provenance: 'regulatory', label: 'SEC EDGAR' },
  ],

  // BOLSY (B3 SA) — IR page (ri.b3.com.br) is server-rendered shell + Mziq
  // JSON API for the document list. We call the same /filter/categories/meta
  // endpoint the browser uses. B3 publishes English translations of material
  // facts, so we request language=en_US.
  'BOLSY US': [
    {
      kind: 'mziq',
      fmId: '5fd7b7d8-54a1-472d-8426-eb896ad8a3c4',
      // Press-release-like categories only. Skip annual reports, governance,
      // and board-meeting minutes (those exist on Mziq but are documentary,
      // not headline news). Full archive of these 4 is ~50–80 items vs
      // ~1600 for everything.
      categories: [
        'documentos_regulatorios_fatos_relevantes',          // Material Facts
        'documentos_regulatorios_aviso_aos_acionistas',      // Notice to Shareholders
        'documentos_regulatorios_cvm_358',                   // CVM 358 material disclosures
        'documentos_regulatorios_assembleias',               // Shareholder Meetings
      ],
      language: 'en_US',
      referer: 'https://ri.b3.com.br/en/regulatory-filings/',
      provenance: 'regulatory',
      label: 'Investor Relations',
    },
  ],

  'WRN US': [
    { kind: 'rss',   url: NEWSFILE(1376),       provenance: 'wire',       label: 'Newsfile' },
    { kind: 'edgar', url: EDGAR('0001364125'),  provenance: 'regulatory', label: 'SEC EDGAR' },
  ],

  // ============================================================
  // TSX / TSXV / Cboe Canada
  // ============================================================

  // ABXX (Abaxx Technologies) — no RSS, but the press-release list ships as
  // a structured JSON array inside the Next.js React Server Component chunks
  // on investors.abaxx.tech/press-releases. Parsed directly from that HTML.
  'ABXX CN': [
    { kind: 'html-abxx', url: 'https://investors.abaxx.tech/press-releases', provenance: 'ir-page', label: 'Investor Relations' },
  ],

  // SHLE (Source Energy Services) — Webflow IR page with each release in a
  // structured block (date-field + slug link + h5 title). HTML-parsed.
  'SHLE CN': [
    { kind: 'html-shle', url: 'https://www.sourceenergyservices.com/investors/news-releases', provenance: 'ir-page', label: 'Investor Relations' },
  ],

  'TGB CN': [
    { kind: 'edgar', url: EDGAR('0000878518'), provenance: 'regulatory', label: 'SEC EDGAR' },
  ],

  'TNZ CN': [
    { kind: 'rss', url: NEWSFILE(11001), provenance: 'wire', label: 'Newsfile' },
  ],

  'VLE CN': [
    { kind: 'rss', url: 'https://www.valeuraenergy.com/feed/', provenance: 'ir-page', label: 'Investor Relations' },
  ],

  'CS CN': [
    { kind: 'rss', url: 'https://capstonecopper.com/feed/', provenance: 'ir-page', label: 'Investor Relations' },
  ],

  'DBG CN': [
    { kind: 'rss', url: NEWSFILE(8003), provenance: 'wire', label: 'Newsfile' },
  ],

  'SCMI CN': [
    { kind: 'rss', url: NEWSFILE(11605), provenance: 'wire', label: 'Newsfile' },
  ],

  // Topicus's RSS publishes item links as https://topicus.com/<slug> — but
  // every one of those 404s; the canonical news pages live at
  // https://topicus.com/news/<slug>. Their feed is just broken. Rewrite
  // every parsed item URL to insert /news/ so click-through works.
  // (Confirmed against the live RSS 2026-06-01: all 80 items needed it.)
  'TOI CN': [
    {
      kind: 'rss',
      url: 'https://www.topicus.com/rss',
      provenance: 'ir-page',
      label: 'Investor Relations',
      urlFix: (u) =>
        u.replace(
          /^https?:\/\/(www\.)?topicus\.com\/(?!news\/|rss\b)/i,
          'https://topicus.com/news/'
        ),
    },
  ],
};

// Wire-source classification pattern. Kept for potential future use; not
// currently invoked anywhere now that the Yahoo wire-filtered backstop has
// been removed.
const WIRE_PATTERNS = [
  /business ?wire/i,
  /globe ?newswire/i,
  /pr ?newswire/i,
  /accesswire/i,
  /^cision\b|cision\.com/i,
  /newsfile ?corp|newsfilecorp/i,
  /access ?newswire/i,
];

export function isWireSource(text) {
  if (!text || typeof text !== 'string') return false;
  return WIRE_PATTERNS.some((p) => p.test(text));
}

// Lookup helper. Returns [] for unknown tickers so callers don't have to
// null-check (an empty press-release list is a valid response shape).
export function getOfficialSources(bloombergTicker) {
  return OFFICIAL_SOURCES[bloombergTicker] || [];
}
