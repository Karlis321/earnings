import { NextRequest, NextResponse } from "next/server";
import { store } from "@/server/store";
import type { Fact, FactMethod, MetricEntry, Provenance } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST /api/manual-entry — write a manual Fact into an event metric.
// Every field in `errors` maps 1:1 to the AddEditSecurityForm inline errors.
//
// Body:
//   eventId      required     — the event to attach to
//   metricKey    required     — dictionary key (e.g. "revenue", "eps_adj")
//   slot         optional     — "actual" | "estimate" | "prior"; default "actual"
//   value        required     — number
//   unit         required     — must match dictionary unit unless overridden
//   sourceUrl    required     — https:// URL (no blind entry, per FE PRD §7.10)
//   asOf         required     — YYYY-MM-DD
//   method       required     — "bloomberg_manual" | "filing_manual" | "llm_extracted"
//   provenance   optional     — Provenance union; default "regulatory"
//   label        optional     — source label; default = URL hostname
//   locator      optional     — anchor / page ref inside the source
//   confidence   optional     — 0..1; default 1
//   displayLabel optional     — used when metric entry needs to be created
//   isHeadline   optional     — used when metric entry needs to be created

const METHOD_SET = new Set<FactMethod>([
  "yahoo",
  "fmp",
  "bloomberg_manual",
  "filing_manual",
  "llm_extracted",
]);

const PROVENANCE_SET = new Set<Provenance>([
  "regulatory",
  "ir-page",
  "wire",
  "news",
  "social",
  "independent",
]);

const SLOT_SET = new Set(["actual", "estimate", "prior"] as const);

function parseUrl(u: string): URL | null {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

interface Body {
  eventId?: string;
  metricKey?: string;
  slot?: "actual" | "estimate" | "prior";
  value?: number | string;
  unit?: string;
  sourceUrl?: string;
  asOf?: string;
  method?: FactMethod;
  provenance?: Provenance;
  label?: string;
  locator?: string | null;
  confidence?: number;
  displayLabel?: string;
  isHeadline?: boolean;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body;
    const fields: Record<string, string> = {};

    if (!body.eventId) fields.eventId = "eventId required";
    if (!body.metricKey) fields.metricKey = "metricKey required";
    if (body.value === undefined || body.value === null || body.value === "") {
      fields.value = "value required";
    } else if (Number.isNaN(Number(body.value))) {
      fields.value = "value must be numeric";
    }
    if (!body.unit) fields.unit = "unit required";
    if (!body.sourceUrl) {
      fields.sourceUrl = "sourceUrl required — no blind entry";
    } else if (!parseUrl(body.sourceUrl)) {
      fields.sourceUrl = "sourceUrl must be a valid https:// URL";
    }
    if (!body.asOf) {
      fields.asOf = "asOf required";
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(body.asOf)) {
      fields.asOf = "asOf must be YYYY-MM-DD";
    }
    if (!body.method || !METHOD_SET.has(body.method)) {
      fields.method = "method must be bloomberg_manual | filing_manual | llm_extracted | yahoo | fmp";
    }
    if (body.slot && !SLOT_SET.has(body.slot)) {
      fields.slot = "slot must be actual | estimate | prior";
    }
    if (body.provenance && !PROVENANCE_SET.has(body.provenance)) {
      fields.provenance = "provenance must be one of regulatory|ir-page|wire|news|social|independent";
    }
    if (body.confidence !== undefined) {
      if (typeof body.confidence !== "number" || body.confidence < 0 || body.confidence > 1) {
        fields.confidence = "confidence must be a number in [0, 1]";
      }
    }
    if (Object.keys(fields).length) {
      return NextResponse.json({ error: "bad_request", fields }, { status: 400 });
    }

    if (store.mode() === "in-memory") {
      return NextResponse.json(
        {
          error: "persistence-unavailable",
          message: "Set GH_PAT + GH_REPO_OWNER + GH_REPO_NAME in Vercel env.",
        },
        { status: 503 },
      );
    }

    const slot = body.slot ?? "actual";
    const url = parseUrl(body.sourceUrl!)!;
    const fact: Fact = {
      value: Number(body.value),
      unit: body.unit!,
      source: {
        url: url.toString(),
        label: body.label ?? url.hostname,
        provenance: body.provenance ?? "regulatory",
        locator: body.locator ?? null,
      },
      asOf: body.asOf!,
      fetchedAt: new Date().toISOString(),
      method: body.method!,
      confidence: body.confidence ?? 1,
    };

    const snap = await store.readEarnings();
    const event = snap.events.find((e) => e.id === body.eventId);
    if (!event) {
      return NextResponse.json(
        { error: "not_found", message: `no event ${body.eventId}` },
        { status: 404 },
      );
    }

    const metrics = event.metrics.slice();
    const idx = metrics.findIndex((m) => m.key === body.metricKey);
    if (idx >= 0) {
      const prev = metrics[idx];
      metrics[idx] = { ...prev, [slot]: fact } as MetricEntry;
    } else {
      metrics.push({
        key: body.metricKey!,
        displayLabel: body.displayLabel ?? body.metricKey!,
        isHeadline: Boolean(body.isHeadline),
        surprisePct: null,
        estimate: slot === "estimate" ? fact : null,
        actual: slot === "actual" ? fact : null,
        prior: slot === "prior" ? fact : null,
      });
    }

    await store.upsertEvent({ ...event, metrics });
    return NextResponse.json({ ok: true, eventId: event.id, metricKey: body.metricKey, slot });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("409")) {
      return NextResponse.json({ error: "conflict", message: msg }, { status: 409 });
    }
    return NextResponse.json({ error: "server", message: msg }, { status: 500 });
  }
}
