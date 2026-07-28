// Shared bearer-token check for write endpoints. Same shape the cron
// route uses — one CRON_SECRET gates every mutating server operation.
// This is deliberately minimal: no user auth, no roles, no RBAC. It
// exists so a stranger can't POST to /api/entity-registry from the
// open internet while GET / read paths stay public.

import { NextRequest, NextResponse } from "next/server";

export function isAuthorizedWrite(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

export function unauthorizedWriteResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "unauthorized",
      message:
        "Write routes require Authorization: Bearer $CRON_SECRET. Set CRON_SECRET in Vercel env; send matching Bearer token.",
    },
    { status: 401 },
  );
}
