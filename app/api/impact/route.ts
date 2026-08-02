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
/** A partial answer is worth re-deriving sooner, since the next pass improves it. */
const PARTIAL_CACHE_MS = 3_000;

/**
 * Module state resets on every cold start, so the in-process cache alone would
 * make a fresh instance pay the full scan. Let the CDN hold the answer too: the
 * figures move only when the agent settles, and the response says when it was built.
 */
/**
 * Only a complete scan is worth holding at the edge.
 *
 * Caching a partial one for five minutes froze it: the sweep only extends its
 * coverage when a request actually reaches the origin, so a cached incomplete
 * answer served everybody and coverage never grew past the first pass. An
 * incomplete response therefore gets a short cache, which lets the next request
 * through to finish the job, and the complete one gets the long cache it deserves.
 */
const CDN_CACHE_COMPLETE = "public, s-maxage=300, stale-while-revalidate=1800";
const CDN_CACHE_PARTIAL = "public, s-maxage=5, stale-while-revalidate=30";
const cacheFor = (body: unknown) =>
  (body as { coverage?: { complete?: boolean } })?.coverage?.complete ? CDN_CACHE_COMPLETE : CDN_CACHE_PARTIAL;

/**
 * Spigot's public record. Every number in the response is fetched from a ledger
 * Spigot does not control, on request, rather than served from a database.
 */
export async function GET() {
  const ttl = cacheFor(cached?.body) === CDN_CACHE_COMPLETE ? CACHE_MS : PARTIAL_CACHE_MS;
  if (cached && Date.now() - cached.at < ttl) {
    return NextResponse.json(cached.body, { headers: { "x-spigot-cache": "hit", "cache-control": cacheFor(cached.body) } });
  }

  try {
    const impact = await buildImpact();
    cached = { at: Date.now(), body: impact };
    return NextResponse.json(impact, { headers: { "x-spigot-cache": "miss", "cache-control": cacheFor(impact) } });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not build the impact record.", reason: (err as Error).message },
      { status: 503 },
    );
  }
}
