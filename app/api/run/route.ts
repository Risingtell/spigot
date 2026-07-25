import { NextResponse } from "next/server";
import { MemoryStore, MockSettlementProvider, StreamingMeter, type SettlementProvider } from "meter402";
import { StreamingAgent, type TickContext } from "@/src/agent";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "@/src/arc";
import { economicSettlementSeconds, fetchSettlementCost, minEconomicSettlementUnits } from "@/src/arc-gas";
import { ArcEoaSettlementProvider, arcKeyConfigured } from "@/src/arc-eoa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the real Spigot agent loop so anyone can click and watch an autonomous agent
 * hold a metered stream, pay for it, and shut its own gate.
 *
 * When this deployment holds an Arc key, every settlement below is a real confirmed
 * USDC transfer on Arc Testnet with a live explorer link. Without one it runs the
 * identical loop against a simulated settlement provider. Either way the fee market
 * driving the cadence is read live from Arc, and the response says which mode it
 * ran in so the page never has to guess.
 */

const RATE_PER_SECOND = "50000"; // $0.05/sec of held capacity
const MAX_OVERHEAD_RATIO = 0.05;
/** Where settlement lands when this deployment is running live. */
const LIVE_PROVIDER = process.env.SPIGOT_PROVIDER_ADDRESS;
const SIMULATED_PROVIDER = "0xProviderTreasury000000000000000000000000";

/**
 * Guards on a public endpoint that spends real money: one live run at a time, a
 * minimum gap between them, and a ceiling on what the whole deployment will spend
 * before it stops offering live settlement. Anything the guards block still runs,
 * just simulated, so a judge always sees the loop work.
 */
const MIN_LIVE_GAP_MS = 15_000;
const DEPLOYMENT_SPEND_CAP_UNITS = 2_000_000n; // $2 of testnet USDC
let lastLiveRunAt = 0;
let liveRunInFlight = false;
let liveSpentUnits = 0n;

function liveRunAllowed(): boolean {
  if (!arcKeyConfigured() || !LIVE_PROVIDER) return false;
  if (liveRunInFlight) return false;
  if (liveSpentUnits >= DEPLOYMENT_SPEND_CAP_UNITS) return false;
  return Date.now() - lastLiveRunAt >= MIN_LIVE_GAP_MS;
}

interface Scenario {
  id: string;
  label: string;
  blurb: string;
  budgetUnits: string;
  maxRatePerSecondUnits: string;
  base: number;
  slope: number;
}

const SCENARIOS: Record<string, Scenario> = {
  fresh: {
    id: "fresh",
    label: "Work keeps coming",
    blurb: "The capacity keeps earning its price, so the agent keeps holding it and settles as it goes.",
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    base: 1.9,
    slope: 0.06,
  },
  stale: {
    id: "stale",
    label: "Queue drains",
    blurb: "The work runs out fast. The agent sees the next slice is not worth its price, and lets go.",
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    base: 1.8,
    slope: 0.16,
  },
  budget: {
    id: "budget",
    label: "Tight budget",
    blurb: "The capacity stays valuable, but the agent will not spend past the hard budget it was given.",
    budgetUnits: "60000",
    maxRatePerSecondUnits: "100000",
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
    // no body - use default
  }
  const scenario = SCENARIOS[scenarioId];

  const live = liveRunAllowed();
  const payTo = live && LIVE_PROVIDER ? LIVE_PROVIDER : SIMULATED_PROVIDER;

  let provider: SettlementProvider = new MockSettlementProvider();
  let agentWallet = "agent-alpha-wallet";
  if (live) {
    try {
      const arc = new ArcEoaSettlementProvider();
      provider = arc;
      agentWallet = arc.address;
    } catch {
      // No usable key after all - run simulated rather than fail the request.
    }
  }
  const settlingLive = !provider.mock;

  const store = new MemoryStore([
    {
      id: "inference-stream",
      title: "Low-latency inference capacity",
      description: "Reserved model capacity, billed for exactly the time it is held.",
      ratePerSecond: RATE_PER_SECOND,
      asset: "USDC",
      provider: "NimbusCompute",
      payTo,
    },
  ]);

  const meter = new StreamingMeter(store, {
    payTo,
    maxTickSeconds: 60,
    network: ARC_TESTNET_CAIP2,
  });

  // What one settlement costs on Arc right now. This is a live read, not a constant.
  const cost = await fetchSettlementCost();
  const minSettle = minEconomicSettlementUnits(cost.costUnits, MAX_OVERHEAD_RATIO);

  const agent = new StreamingAgent(meter, provider, agentWallet, {
    budgetUnits: scenario.budgetUnits,
    maxRatePerSecondUnits: scenario.maxRatePerSecondUnits,
    objective: "Hold inference capacity only while it is worth more than it costs.",
    settlement: { costUnits: cost.costUnits, maxOverheadRatio: MAX_OVERHEAD_RATIO, meterMaxTickSeconds: 60 },
  });

  const valueSignal = (ctx: TickContext): number =>
    Number(ctx.marginalUnits) * (scenario.base - scenario.slope * ctx.tick);

  if (settlingLive) {
    liveRunInFlight = true;
    lastLiveRunAt = Date.now();
  }

  let result;
  try {
    result = await agent.stream("inference-stream", { valueSignal, tickIntervalMs: 150, maxTicks: 40 });
  } finally {
    if (settlingLive) {
      liveRunInFlight = false;
      liveSpentUnits += BigInt(meter.impact().totals.totalPaid || "0");
    }
  }

  const events = meter.impact().recent.slice().reverse(); // oldest first
  let cumulative = 0n;
  const settlements = events.map((e, i) => {
    cumulative += BigInt(e.amount);
    return {
      n: i + 1,
      seconds: e.seconds,
      amountUsd: unitsToUsdc(e.amount),
      cumulativeUsd: unitsToUsdc(cumulative.toString()),
      // What Arc's fee took out of this one settlement.
      feeSharePct: (Number(cost.costUnits) / Number(e.amount)) * 100,
      txHash: e.txHash,
      explorerUrl: e.explorerUrl,
    };
  });

  const spentUnits = Number(result.spentUnits);
  const feeSharePct = result.settlements > 0 ? (Number(cost.costUnits) * result.settlements * 100) / spentUnits : 0;

  return NextResponse.json({
    mode: settlingLive ? "live" : "simulated",
    agent: settlingLive ? agentWallet : undefined,
    scenario: {
      id: scenario.id,
      label: scenario.label,
      blurb: scenario.blurb,
      ratePerSecondUsd: unitsToUsdc(RATE_PER_SECOND),
      budgetUsd: unitsToUsdc(scenario.budgetUnits),
    },
    fee: {
      gasPriceGwei: cost.gasPriceGwei,
      source: cost.source,
      settlementCostUsd: cost.costUsd,
      minSettlementUsd: unitsToUsdc(minSettle.toString()),
      cadenceSeconds: economicSettlementSeconds(minSettle, RATE_PER_SECOND),
    },
    settlements,
    decision: {
      reason: result.closedReason,
      settlements: result.settlements,
      ticksMetered: result.ticksMetered,
      spentUsd: unitsToUsdc(result.spentUnits),
      feeSharePct,
    },
    network: meter.impact().network,
  });
}
