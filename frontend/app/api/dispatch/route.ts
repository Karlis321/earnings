import { NextRequest, NextResponse } from "next/server";

// POST /api/dispatch — fires a GitHub Actions workflow_dispatch on
// one of the allowlisted AI-writing workflows. Auth is bearer
// CRON_SECRET (same convention as /api/summarize).
//
// Body: { workflow: string, inputs?: Record<string, string> }
// where workflow is one of ALLOWED_WORKFLOWS.
//
// Returns 202 on successful dispatch, 401 on bad auth, 403 on
// unknown workflow, 502 when GitHub rejects.

export const dynamic = "force-dynamic";

// Only these are dispatchable. Adding a new workflow requires
// updating this list — deliberate friction to keep the surface
// narrow.
const ALLOWED_WORKFLOWS = new Set<string>([
  "week-ahead.yml",
  "framework-screen.yml",
]);

// Small in-memory rate limiter — prevents click-spam from
// draining the AI quota pool. 5-minute cooldown per workflow.
const lastDispatchByWorkflow = new Map<string, number>();
const COOLDOWN_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  // Auth
  const secret = process.env.CRON_SECRET ?? "";
  const auth = req.headers.get("authorization") ?? "";
  if (!secret) {
    return NextResponse.json(
      { error: "misconfigured", message: "CRON_SECRET not set in env" },
      { status: 503 },
    );
  }
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json(
      { error: "unauthorized", message: "Bearer CRON_SECRET required" },
      { status: 401 },
    );
  }

  // Body
  let body: { workflow?: string; inputs?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "JSON body required" },
      { status: 400 },
    );
  }
  const workflow = body.workflow;
  if (!workflow || typeof workflow !== "string") {
    return NextResponse.json(
      { error: "bad_request", message: "workflow field required" },
      { status: 400 },
    );
  }
  if (!ALLOWED_WORKFLOWS.has(workflow)) {
    return NextResponse.json(
      {
        error: "forbidden",
        message: `workflow "${workflow}" not in allowlist`,
        allowed: [...ALLOWED_WORKFLOWS],
      },
      { status: 403 },
    );
  }

  // Cooldown
  const now = Date.now();
  const last = lastDispatchByWorkflow.get(workflow) ?? 0;
  if (now - last < COOLDOWN_MS) {
    const retryInSec = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `${workflow} was dispatched ${Math.floor((now - last) / 1000)}s ago; cooldown is ${COOLDOWN_MS / 1000}s`,
        retryAfterSec: retryInSec,
      },
      { status: 429, headers: { "Retry-After": String(retryInSec) } },
    );
  }

  // Dispatch
  const pat = process.env.GH_PAT;
  const owner = process.env.GH_REPO_OWNER;
  const repo = process.env.GH_REPO_NAME;
  if (!pat || !owner || !repo) {
    return NextResponse.json(
      {
        error: "misconfigured",
        message: "GH_PAT + GH_REPO_OWNER + GH_REPO_NAME env vars required",
      },
      { status: 503 },
    );
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  const gh = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "EarningsDashboard/1.0",
    },
    body: JSON.stringify({
      ref: "main",
      ...(body.inputs ? { inputs: body.inputs } : {}),
    }),
  });
  if (!gh.ok) {
    const text = await gh.text();
    return NextResponse.json(
      {
        error: "dispatch-failed",
        message: `GitHub → HTTP ${gh.status}`,
        detail: text.slice(0, 240),
      },
      { status: 502 },
    );
  }

  lastDispatchByWorkflow.set(workflow, now);
  return NextResponse.json(
    {
      ok: true,
      workflow,
      dispatchedAt: new Date(now).toISOString(),
      message: `${workflow} dispatched — check the Actions tab for the run`,
    },
    { status: 202 },
  );
}
