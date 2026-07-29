import { NextResponse } from "next/server";
import { buildImpact } from "@/src/impact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Scanning Arc's log range is not free; a short cache keeps it civil. */
export const revalidate = 0;

let cached: { at: number; body: unknown } | null = null;
const CACHE_MS = 30_000;

/**
 * Spigot's public record. Every number in the response is fetched from a ledger
 * Spigot does not control, on request, rather than served from a database.
 */
export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(cached.body, { headers: { "x-spigot-cache": "hit" } });
  }

  try {
    const impact = await buildImpact();
    cached = { at: Date.now(), body: impact };
    return NextResponse.json(impact, { headers: { "x-spigot-cache": "miss" } });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not build the impact record.", reason: (err as Error).message },
      { status: 503 },
    );
  }
}
