import { NextResponse } from "next/server";
import { MemoryStore, MockSettlementProvider, StreamingMeter } from "meter402";
import { StreamingAgent, type TickContext } from "@/src/agent";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "@/src/arc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the real Spigot agent loop in mock mode (no keys, no chain) so anyone can
 * click and watch an autonomous agent stream, pay per second, and shut its own
 * gate. The same loop runs live on Arc when ArcSettlementProvider is wired in.
 */

interface Scenario {
  id: string;
  label: string;
  blurb: string;
  ratePerSecond: string;
  budgetUnits: string;
  maxRatePerSecondUnits: string;
  base: number;
  slope: number;
}

const SCENARIOS: Record<string, Scenario> = {
  fresh: {
    id: "fresh",
    label: "Signal stays fresh",
    blurb: "The feed keeps earning its price, so the agent keeps paying, second after second.",
    ratePerSecond: "1000",
    budgetUnits: "50000",
    maxRatePerSecondUnits: "5000",
    base: 2.2,
    slope: 0.16,
  },
  stale: {
    id: "stale",
    label: "Signal goes stale",
    blurb: "The feed's edge decays fast. The agent notices the next second is not worth it, and stops.",
    ratePerSecond: "1000",
    budgetUnits: "50000",
    maxRatePerSecondUnits: "5000",
    base: 1.95,
    slope: 0.28,
  },
  budget: {
    id: "budget",
    label: "Tight budget",
    blurb: "The feed stays valuable, but the agent will not spend past the hard budget it was given.",
    ratePerSecond: "1000",
    budgetUnits: "600",
    maxRatePerSecondUnits: "5000",
    base: 3,
    slope: 0,
  },
};

export async function POST(req: Request) {
  let scenarioId = "stale";
  try {
    const body = (await req.json()) as { scenario?: string };
    if (body.scenario && SCENARIOS[body.scenario]) scenarioId = body.scenario;
  } catch {
    // no body — use default
  }
  const scenario = SCENARIOS[scenarioId];

  const store = new MemoryStore([
    {
      id: "btc-risk-feed",
      title: "BTC liquidation-risk feed",
      description: "Streaming liquidation-risk signal for BTC perps.",
      ratePerSecond: scenario.ratePerSecond,
      asset: "USDC",
      provider: "RiskLabs",
      payTo: "0xProviderTreasury000000000000000000000000",
    },
  ]);

  const meter = new StreamingMeter(store, {
    payTo: "0xProviderTreasury000000000000000000000000",
    maxTickSeconds: 10,
    network: ARC_TESTNET_CAIP2,
  });

  const agent = new StreamingAgent(meter, new MockSettlementProvider(), "agent-alpha-wallet", {
    budgetUnits: scenario.budgetUnits,
    maxRatePerSecondUnits: scenario.maxRatePerSecondUnits,
    objective: "Hold the BTC risk feed only while its edge beats the price.",
  });

  const valueSignal = (ctx: TickContext): number => {
    const cost = Number(ctx.quote.amount);
    return cost * (scenario.base - scenario.slope * ctx.tick);
  };

  const result = await agent.stream("btc-risk-feed", { valueSignal, tickIntervalMs: 150, maxTicks: 40 });

  const events = meter.impact().recent.slice().reverse(); // oldest first
  let cumulative = 0n;
  const ticks = events.map((e, i) => {
    cumulative += BigInt(e.amount);
    return {
      n: i + 1,
      seconds: e.seconds,
      amountUsd: unitsToUsdc(e.amount),
      cumulativeUsd: unitsToUsdc(cumulative.toString()),
      txHash: e.txHash,
    };
  });

  return NextResponse.json({
    scenario: {
      id: scenario.id,
      label: scenario.label,
      blurb: scenario.blurb,
      ratePerSecondUsd: unitsToUsdc(scenario.ratePerSecond),
      budgetUsd: unitsToUsdc(scenario.budgetUnits),
    },
    ticks,
    decision: {
      reason: result.closedReason,
      ticksPaid: result.ticksPaid,
      spentUsd: unitsToUsdc(result.spentUnits),
    },
    network: meter.impact().network,
  });
}
