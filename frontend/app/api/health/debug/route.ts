import { NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

// GET /api/health/debug
// Non-secret metadata about env-var configuration + a live probe of the
// git-snapshot store's read path. Reports enough to diagnose repo /
// branch misconfiguration without exposing secret values.
//
// Fingerprints show LENGTH + first + last character only — enough to
// catch a stray trailing space or wrong-casing but not enough to
// reconstruct the value.
function fingerprint(v: string | undefined): {
  set: boolean;
  length: number;
  first: string | null;
  last: string | null;
  hasLeadingSpace: boolean;
  hasTrailingSpace: boolean;
  containsCapital: boolean;
} {
  if (!v) {
    return {
      set: false,
      length: 0,
      first: null,
      last: null,
      hasLeadingSpace: false,
      hasTrailingSpace: false,
      containsCapital: false,
    };
  }
  return {
    set: true,
    length: v.length,
    first: v[0] ?? null,
    last: v[v.length - 1] ?? null,
    hasLeadingSpace: /^\s/.test(v),
    hasTrailingSpace: /\s$/.test(v),
    containsCapital: /[A-Z]/.test(v),
  };
}

export async function GET() {
  const env = {
    GH_REPO_OWNER: fingerprint(process.env.GH_REPO_OWNER),
    GH_REPO_NAME: fingerprint(process.env.GH_REPO_NAME),
    GH_BRANCH: fingerprint(process.env.GH_BRANCH),
    GH_PAT_present: !!process.env.GH_PAT,
    CRON_SECRET_present: !!process.env.CRON_SECRET,
  };

  // Compare against expected values so the user can see mismatches without
  // us echoing either side.
  const matches = {
    GH_REPO_OWNER_equals_Karlis321: process.env.GH_REPO_OWNER === "Karlis321",
    GH_REPO_NAME_equals_earnings: process.env.GH_REPO_NAME === "earnings",
    GH_BRANCH_equals_main: process.env.GH_BRANCH === "main" || !process.env.GH_BRANCH,
  };

  // Live probe of the git-snapshot store's registry read. If mismatch,
  // registryReadCount will fall back to the fixture (17) or fewer.
  let registryReadCount: number | null = null;
  let registryReadError: string | null = null;
  try {
    const ents = await store.readRegistry();
    registryReadCount = ents.length;
  } catch (e) {
    registryReadError = (e as Error).message;
  }

  // Direct GitHub API probe — reveals the actual HTTP status of the read
  // that store.readRegistry silently swallows. This is what tells us
  // WHY the store is falling back to the fixture.
  let ghProbe: {
    status: number | null;
    statusText: string | null;
    contentLength: number | null;
    bodyPreview: string | null;
    error: string | null;
  } = {
    status: null,
    statusText: null,
    contentLength: null,
    bodyPreview: null,
    error: null,
  };
  const pat = process.env.GH_PAT;
  const owner = process.env.GH_REPO_OWNER;
  const repo = process.env.GH_REPO_NAME;
  const branch = process.env.GH_BRANCH ?? "main";
  if (pat && owner && repo) {
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent("data/entity-registry.json")}?ref=${encodeURIComponent(branch)}`;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "EarningsDashboard/1.0",
        },
        cache: "no-store",
      });
      ghProbe.status = r.status;
      ghProbe.statusText = r.statusText;
      const text = await r.text();
      ghProbe.contentLength = text.length;
      // First 300 chars only — enough to see error messages without
      // leaking a full 500KB registry file.
      ghProbe.bodyPreview = text.slice(0, 300);
    } catch (e) {
      ghProbe.error = (e as Error).message;
    }
  }

  return NextResponse.json(
    {
      env,
      matches,
      storeMode: store.mode(),
      registryReadCount,
      registryReadError,
      ghProbe,
      note:
        registryReadCount === 17
          ? "Only 17 entities returned = git-snapshot store is falling back to fixture. Check that all three matches.* are true."
          : registryReadCount && registryReadCount > 100
          ? "Registry >100 entities = git-snapshot store is reading the correct GitHub repo. Env config is good."
          : "Unexpected registry size. Check registryReadError.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
