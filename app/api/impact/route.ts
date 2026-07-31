import { NextResponse } from "next/server";
import { buildImpact } from "@/src/impact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Scanning Arc's log range is not free; a short cache keeps it civil. */
export const revalidate = 0;
/**
 * Arc throttles log queries hard, so re-deriving the settlement window takes tens
 * of seconds on a cold instance. The default ten is not enough and the request
 * would be killed mid-scan, which reads as a broken endpoint rather than a slow one.
 */
export const maxDuration = 60;

let cached: { at: number; body: unknown } | null = null;
const CACHE_MS = 30_000;

/**
 * Module state resets on every cold start, so the in-process cache alone would
 * make a fresh instance pay the full scan. Let the CDN hold the answer too: the
 * figures move only when the agent settles, and the response says when it was built.
 */
const CDN_CACHE = "public, s-maxage=300, stale-while-revalidate=1800";

/**
 * Spigot's public record. Every number in the response is fetched from a ledger
 * Spigot does not control, on request, rather than served from a database.
 */
export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(cached.body, { headers: { "x-spigot-cache": "hit", "cache-control": CDN_CACHE } });
  }

  try {
    const impact = await buildImpact();
    cached = { at: Date.now(), body: impact };
    return NextResponse.json(impact, { headers: { "x-spigot-cache": "miss", "cache-control": CDN_CACHE } });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not build the impact record.", reason: (err as Error).message },
      { status: 503 },
    );
  }
}
