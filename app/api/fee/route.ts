import { NextResponse } from "next/server";
import { ARC_TESTNET_RPC, unitsToUsdc } from "@/src/arc";
import { economicSettlementSeconds, fetchSettlementCost, minEconomicSettlementUnits } from "@/src/arc-gas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Arc's fee market, live, with the settlement cadence it implies at several
 * stream prices. This is the number Spigot's whole design rests on: gas on Arc is
 * USDC, so the cost of settling is directly comparable to the value being settled,
 * and the agent can schedule around it instead of guessing. Anyone can check it
 * with a single eth_gasPrice call against the public RPC.
 */

const MAX_OVERHEAD_RATIO = 0.05;

const STREAM_PRICES: { label: string; ratePerSecond: string }[] = [
  { label: "Market data feed", ratePerSecond: "1000" }, //     $0.001/sec
  { label: "Inference capacity", ratePerSecond: "50000" }, //   $0.05/sec
  { label: "Reserved GPU", ratePerSecond: "500000" }, //        $0.50/sec
];

export async function GET() {
  const cost = await fetchSettlementCost();
  const minSettle = minEconomicSettlementUnits(cost.costUnits, MAX_OVERHEAD_RATIO);

  return NextResponse.json({
    rpc: ARC_TESTNET_RPC,
    gasPriceGwei: cost.gasPriceGwei,
    gasLimit: cost.gasLimit,
    source: cost.source,
    settlementCostUsd: cost.costUsd,
    maxOverheadRatio: MAX_OVERHEAD_RATIO,
    minSettlementUsd: unitsToUsdc(minSettle.toString()),
    measuredAt: cost.measuredAt,
    cadence: STREAM_PRICES.map((s) => ({
      label: s.label,
      ratePerSecondUsd: unitsToUsdc(s.ratePerSecond),
      settleEverySeconds: economicSettlementSeconds(minSettle, s.ratePerSecond),
    })),
  });
}
