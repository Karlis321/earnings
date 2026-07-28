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

  return NextResponse.json(
    {
      env,
      matches,
      storeMode: store.mode(),
      registryReadCount,
      registryReadError,
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
