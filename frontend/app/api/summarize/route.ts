// POST /api/summarize — fires a repository_dispatch (type "summarize")
// on the same repo we deploy from, which triggers the claude-summarize
// GitHub Actions workflow with the requested ticker.
//
// Auth: Authorization: Bearer $CRON_SECRET (same convention as
// /api/cron/daily — a personal-dashboard shared secret, not a
// per-user login).
//
// Gates:
//   - 401 if the Bearer token is missing/wrong.
//   - 400 if the request body doesn't parse or `ticker` isn't a string.
//   - 404 if the ticker isn't in the entity registry.
//   - 403 if the ticker exists but isn't in the covered tier
//     (`data/covered.json`). Wider-universe automation is out of scope
//     for v1 — the mechanical/KPI-only path for the tail comes later.
//   - 409 if a summary for the ticker's latest reported period already
//     exists — the panel would render it, so a dispatch would be a
//     no-op. Body carries `existingPeriod` so the UI can explain.
//   - 429 if a dispatch for the same ticker fired in the last 15
//     minutes (per-instance in-memory cache). Prevents button-mash
//     rate on a warm server; a cold start resets the timer, but this
//     is acceptable — the workflow itself is idempotent (the /earnings
//     command's Step-0 guard early-outs if the summary is already
//     valid).
//   - 503 if GH_PAT / GH_REPO_OWNER / GH_REPO_NAME aren't configured
//     — we can't dispatch without them.

import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

// In-memory rate limiter for repeat dispatches on the same ticker.
// Vercel's serverless runtime shares module state within a warm
// invocation; a cold start clears this map. Fifteen-minute gate
// per the spec.
const RATE_LIMIT_MS = 15 * 60 * 1000;
const lastDispatchByTicker = new Map<string, number>();

function coveredTickers(): Set<string> | null {
  try {
    // data/covered.json is at repo root; from frontend/app/api/summarize/route.ts
    // that's five levels up. process.cwd() at build time might be either
    // /frontend or the repo root — try both.
    const candidates = [
      path.join(process.cwd(), "..", "data", "covered.json"),
      path.join(process.cwd(), "data", "covered.json"),
    ];
    for (const p of candidates) {
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw) as { tickers?: string[] };
        if (Array.isArray(parsed.tickers)) return new Set(parsed.tickers);
      } catch {
        /* try next */
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json(
      { error: "unauthorized", message: "CRON_SECRET required" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad-request", message: "Body must be valid JSON" },
      { status: 400 },
    );
  }
  const ticker =
    body && typeof body === "object" && typeof (body as { ticker?: unknown }).ticker === "string"
      ? (body as { ticker: string }).ticker
      : null;
  const force =
    body && typeof body === "object" && (body as { force?: unknown }).force === true;
  if (!ticker) {
    return NextResponse.json(
      { error: "bad-request", message: "Body must be {ticker: string, force?: boolean}" },
      { status: 400 },
    );
  }

  const entities = await store.readRegistry();
  const entity = entities.find((e) => e.ticker === ticker);
  if (!entity) {
    return NextResponse.json(
      { error: "not-found", message: `Ticker "${ticker}" not in registry` },
      { status: 404 },
    );
  }

  // Resolve to canonical — the workflow itself accepts any registered
  // ticker, but the covered-tier gate should compare against the
  // canonical form so a non-canonical member (e.g. HBM CN) still
  // resolves correctly.
  let canonical = entity;
  if (entity.isCanonical === false && entity.companyId) {
    const canon = entities.find(
      (e) => e.companyId === entity.companyId && e.isCanonical !== false,
    );
    if (canon) canonical = canon;
  }
  const covered = coveredTickers();
  if (covered && !covered.has(canonical.ticker) && !covered.has(ticker)) {
    return NextResponse.json(
      {
        error: "not-covered",
        message: `Ticker "${canonical.ticker}" isn't in the covered tier — /api/summarize is covered-only for v1`,
      },
      { status: 403 },
    );
  }

  // Existing-summary gate — if the latest reported period already has
  // a summary, dispatching would be a no-op (the /earnings command's
  // Step-0 guard would early-out). Surface that state to the UI.
  // BYPASSED when the caller passed `force: true` (regenerate button).
  if (!force && store.readSummariesForTicker) {
    const summaries = await store.readSummariesForTicker(ticker);
    if (summaries.length > 0) {
      // Compare against the ticker's latest reported period.
      const events = store.readEventsForTicker
        ? await store.readEventsForTicker(canonical.ticker)
        : [];
      const past = events.filter((e) => e.eventDate);
      past.sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));
      const latestPeriod = past[0]?.period ?? null;
      if (latestPeriod && summaries.some((s) => s.period === latestPeriod)) {
        return NextResponse.json(
          {
            error: "already-summarized",
            message: `Summary for "${canonical.ticker} ${latestPeriod}" already exists`,
            existingPeriod: latestPeriod,
          },
          { status: 409 },
        );
      }
    }
  }

  // Rate limit — 15 minutes per ticker.
  const now = Date.now();
  const key = canonical.ticker;
  const prev = lastDispatchByTicker.get(key);
  if (prev && now - prev < RATE_LIMIT_MS) {
    const retryInSec = Math.ceil((RATE_LIMIT_MS - (now - prev)) / 1000);
    return NextResponse.json(
      {
        error: "rate-limited",
        message: `Dispatch for "${canonical.ticker}" fired ${Math.round((now - prev) / 1000)}s ago; wait ${retryInSec}s`,
        retryAfterSec: retryInSec,
      },
      { status: 429, headers: { "Retry-After": String(retryInSec) } },
    );
  }

  // Fire the dispatch.
  const pat = process.env.GH_PAT;
  const owner = process.env.GH_REPO_OWNER;
  const repo = process.env.GH_REPO_NAME;
  if (!pat || !owner || !repo) {
    return NextResponse.json(
      {
        error: "misconfigured",
        message: "GH_PAT + GH_REPO_OWNER + GH_REPO_NAME env vars required to dispatch",
      },
      { status: 503 },
    );
  }
  const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
  const r = await fetch(dispatchUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "EarningsDashboard/1.0",
    },
    body: JSON.stringify({
      event_type: "summarize",
      client_payload: { ticker: canonical.ticker, force },
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    return NextResponse.json(
      {
        error: "dispatch-failed",
        message: `GitHub dispatch → HTTP ${r.status}`,
        detail: text.slice(0, 240),
      },
      { status: 502 },
    );
  }

  lastDispatchByTicker.set(key, now);
  return NextResponse.json(
    {
      ok: true,
      ticker: canonical.ticker,
      dispatchedAt: new Date(now).toISOString(),
      etaMinutes: 5,
      message:
        "Repository dispatch fired — the workflow typically completes in ~3 minutes; the summary lands as a claude[bot] commit when done",
    },
    { status: 202 },
  );
}
