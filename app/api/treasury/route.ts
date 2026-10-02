import { NextResponse } from "next/server";
import { unitsToUsdc } from "@/src/arc";
import { ArcEoaSettlementProvider, arcKeyConfigured } from "@/src/arc-eoa";
import { DEFAULT_RESERVE_CHAIN, planTopUp, treasuryPolicy, unifiedBalance } from "@/src/treasury";
import { DIRECT_RESERVE_UNITS, GATEWAY_RESERVE_UNITS } from "@/src/reserves";
import { gatewayAvailableUnits } from "@/src/nano";
import { ARC, arcAddressUrl } from "@/src/arc";

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

const FLOOR_USDC = 0.5;
const TARGET_USDC = 2;

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
    const [balance, onArc, gatewayUnits] = await Promise.all([
      unifiedBalance(key),
      new ArcEoaSettlementProvider().balanceUnits(),
      // A rail that cannot be read is reported as not ready rather than assumed
      // ready: the page would otherwise promise a live run it cannot deliver.
      gatewayAvailableUnits().catch(() => null),
    ]);

    const policy = treasuryPolicy({ floorUsdc: FLOOR_USDC, targetUsdc: TARGET_USDC, reserveChain: DEFAULT_RESERVE_CHAIN });
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
      /**
       * What the next click will actually do, decided by the same two constants
       * `/api/run` decides with. Reported per rail, because they draw on
       * different balances and run dry independently.
       */
      readiness: {
        network: ARC.name,
        chainId: ARC.chainId,
        agentUrl: arcAddressUrl(new ArcEoaSettlementProvider().address),
        direct: {
          live: onArc >= DIRECT_RESERVE_UNITS,
          balanceUsd: unitsToUsdc(onArc.toString()),
          reserveUsd: unitsToUsdc(DIRECT_RESERVE_UNITS.toString()),
        },
        nano: {
          live: gatewayUnits !== null && gatewayUnits >= GATEWAY_RESERVE_UNITS,
          balanceUsd: gatewayUnits === null ? null : unitsToUsdc(gatewayUnits.toString()),
          reserveUsd: unitsToUsdc(GATEWAY_RESERVE_UNITS.toString()),
        },
      },
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
