import { NextResponse } from "next/server";
import { store } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const entities = await store.readRegistry();
  return NextResponse.json(
    { schema: "entity-registry/v1", entities },
    { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } },
  );
}
