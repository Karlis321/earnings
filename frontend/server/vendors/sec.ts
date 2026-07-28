// SEC EDGAR — server-side wrappers.
//
// Ported from scripts/backfill-sec-submissions-shells.mjs. Uses SEC's
// submissions/CIK{n}.json endpoint to build past-event shells for foreign
// filers (20-F/40-F/6-K) and US filers (10-Q/10-K) where Yahoo returned
// nothing. These shells carry no metric values (only a filing_reference
// marker) but give the median-gap estimator a real historical rhythm to
// project a next-event date, and provide real SEC filing URLs for
// click-through.
//
// EDGAR requires a contact `User-Agent` (per PRD Appendix A quirks).

import type { Entity, EventRecord, Horizon, MetricEntry, ReactionPoint } from "@/lib/types";

// PRD Appendix A: EDGAR requires an identifying UA (email/contact form).
const SEC_UA = "Earnings Tracker (contact@example.com)";
const PERIODIC_FORMS = new Set(["10-Q", "10-K", "40-F", "20-F", "6-K"]);

const HORIZONS: Horizon[] = ["d1", "d3", "w1", "m1"];
const HORIZON_TRADING_DAYS: Record<Horizon, number> = {
  d1: 1,
  d3: 3,
  w1: 5,
  m1: 21,
};

interface SecSubmissionsResp {
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      accessionNumber?: string[];
    };
  };
}

interface PeriodicFiling {
  form: string;
  filed: string;
  accession: string | undefined;
}

async function fetchSubmissions(cik: string): Promise<SecSubmissionsResp | null> {
  const padded = String(cik).padStart(10, "0");
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    return (await r.json()) as SecSubmissionsResp;
  } catch {
    return null;
  }
}

function extractPeriodicFilings(sub: SecSubmissionsResp): PeriodicFiling[] {
  const recent = sub.filings?.recent ?? {};
  const forms = recent.form ?? [];
  const filed = recent.filingDate ?? [];
  const accession = recent.accessionNumber ?? [];
  const out: PeriodicFiling[] = [];
  for (let i = 0; i < forms.length; i++) {
    if (!PERIODIC_FORMS.has(forms[i])) continue;
    if (!filed[i]) continue;
    out.push({ form: forms[i], filed: filed[i], accession: accession[i] });
  }
  return out;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `evt-${Math.abs(h).toString(36).slice(0, 7)}`;
}

function periodFromDate(iso: string): { year: number; quarter: number; label: string } {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return { year: y, quarter: q, label: `FY${y} Q${q}` };
}

function buildPastShell(
  entity: Entity,
  filedDate: string,
  filingForm: string,
  accession: string | undefined,
): EventRecord {
  const { label } = periodFromDate(filedDate);
  const paddedCik = String(entity.edgarCik ?? "").padStart(10, "0");
  const sourceUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${encodeURIComponent(filingForm)}`;
  const id = hashId(`${entity.ticker}_${filedDate}_${filingForm}`);
  const now = new Date().toISOString();

  const metric: MetricEntry = {
    key: "filing_reference",
    displayLabel: `${filingForm} filing`,
    isHeadline: false,
    surprisePct: null,
    estimate: null,
    actual: {
      value: 1,
      // SEC submissions has no numeric metric — the "unit" here is the
      // form type as a label. Currency-per-datapoint rule (audit finding)
      // does not apply because this shell carries no measured currency.
      unit: filingForm,
      source: {
        url: sourceUrl,
        label: `SEC EDGAR · ${filingForm} · ${accession ?? ""}`,
        provenance: "regulatory",
        locator: null,
      },
      asOf: filedDate,
      fetchedAt: now,
      method: "filing_manual",
      confidence: 0.99,
    },
    prior: null,
  };

  const points: ReactionPoint[] = HORIZONS.map((h) => ({
    horizon: h,
    absReturn: null,
    excessReturn: null,
    benchmark: entity.benchmark ?? "",
    computedAt: null,
    populatesOn: addDays(filedDate, HORIZON_TRADING_DAYS[h] + 2),
  }));

  return {
    id,
    ticker: entity.ticker,
    kind: "earnings",
    period: label,
    scheduledDate: filedDate,
    eventDate: filedDate,
    timing: null,
    expectation: "unset",
    guidanceMove: null,
    freshness: "fresh",
    // Audit finding: stamp provenance + provenanceAsOf at creation.
    provenance: "sec-submissions",
    provenanceAsOf: now,
    metrics: [metric],
    guidance: [],
    reaction: {
      benchmark: entity.benchmark ?? "",
      baselineDate: null,
      baselineClose: null,
      points,
    },
    sources: {
      windowStart: addDays(filedDate, -2),
      windowEnd: addDays(filedDate, 35),
      capturedAt: null,
      items: [],
      engineStatus: [],
    },
  };
}

// Build past-event shells from SEC submissions for an entity with edgarCik.
//
// Per memory note `project_estimator_46_nulls`: the cron version pulls the
// LAST 12 periods (not 4 like the offline script did) so semi-annual filers
// get both cycles in history — that's the free-coverage fix scoped for the
// estimator gap. Group filings by fiscal period first (foreign filers submit
// multiple 6-Ks per cycle: interim report + commentary + regulatory), keep
// the earliest filing per period (the real earnings release), then take the
// 12 most recent periods.
//
// Fail-soft: returns `[]` on any error path so cron continues with other
// steps for the same entity.
export async function secSubmissionsShells(entity: Entity): Promise<EventRecord[]> {
  if (!entity.edgarCik) return [];
  const sub = await fetchSubmissions(entity.edgarCik);
  if (!sub) return [];
  const filings = extractPeriodicFilings(sub);
  if (filings.length === 0) return [];

  const byPeriod = new Map<string, PeriodicFiling[]>();
  for (const f of filings) {
    const { label } = periodFromDate(f.filed);
    if (!byPeriod.has(label)) byPeriod.set(label, []);
    byPeriod.get(label)!.push(f);
  }
  const periodEntries = [...byPeriod.entries()]
    .map(([label, group]) => ({
      label,
      // Earliest filing wins — later filings in same quarter are 6-K commentary.
      canonical: group
        .slice()
        .sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""))[0],
    }))
    .sort((a, b) => (b.canonical.filed ?? "").localeCompare(a.canonical.filed ?? ""))
    // Cron pulls 12 periods (not 4) per memory note project_estimator_46_nulls
    // — semi-annual filers get both cycles in history.
    .slice(0, 12);

  return periodEntries.map(({ canonical: f }) =>
    buildPastShell(entity, f.filed, f.form, f.accession),
  );
}
