import { NextResponse } from "next/server";
import { unitsToUsdc } from "@/src/arc";
import { ArcEoaSettlementProvider, arcKeyConfigured } from "@/src/arc-eoa";
import { planTopUp, treasuryPolicy, unifiedBalance } from "@/src/treasury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * What the agent can spend, and where it sits.
 *
 * Two different numbers, and the difference is the whole point. The Arc figure is
 * what the direct rail draws on and the only one a settlement can come out of.
 * The unified balance is everything the agent holds through Gateway, on any chain,
 * and it is what the budget is really written against: when Arc runs low the agent
 * draws from that without choosing a source chain or asking anybody.
 *
 * Both are read live, one from Arc's token contract and one from Circle. Nothing
 * here is stored, same as the impact feed.
 */

const FLOOR_USDC = 5;
const TARGET_USDC = 20;

let cached: { at: number; body: unknown } | null = null;
const CACHE_MS = 30_000;
const CDN_CACHE = "public, s-maxage=60, stale-while-revalidate=600";

export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(cached.body, { headers: { "cache-control": CDN_CACHE, "x-spigot-cache": "hit" } });
  }

  const key = process.env.SPIGOT_ARC_KEY;
  if (!arcKeyConfigured() || !key) {
    return NextResponse.json(
      { available: false, reason: "This deployment holds no agent key, so it has no treasury to report." },
      { status: 200 },
    );
  }

  try {
    const [balance, onArc] = await Promise.all([
      unifiedBalance(key),
      new ArcEoaSettlementProvider().balanceUnits(),
    ]);

    const policy = treasuryPolicy({ floorUsdc: FLOOR_USDC, targetUsdc: TARGET_USDC, reserveChain: "Base_Sepolia" });
    const plan = planTopUp(onArc.toString(), policy);

    const body = {
      available: true,
      agent: new ArcEoaSettlementProvider().address,
      spendableOnArcUsd: unitsToUsdc(onArc.toString()),
      unified: {
        totalUsd: balance.totalUsd,
        chains: balance.perChain.map((c) => ({ chain: c.chain, usd: c.usd })),
      },
      policy: { floorUsd: FLOOR_USDC, targetUsd: TARGET_USDC },
      decision: {
        needed: plan.needed,
        reason: plan.reason,
        wouldDrawUsd: plan.needed ? Number(plan.amountUsdc) : 0,
      },
      note:
        "Spendable on Arc is what a settlement comes out of. The unified balance is everything the agent " +
        "holds through Circle Gateway on any chain; when Arc falls below the floor it draws from that, and " +
        "auto-allocation picks the source chains rather than the agent naming one.",
      builtAt: new Date().toISOString(),
    };

    cached = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { "cache-control": CDN_CACHE, "x-spigot-cache": "miss" } });
  } catch (err) {
    return NextResponse.json(
      { available: false, reason: `The treasury could not be read: ${(err as Error).message}` },
      { status: 200 },
    );
  }
}
