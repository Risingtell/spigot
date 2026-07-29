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
 * Guards on a public endpoint that spends money on every click.
 *
 * The rate limit and the in-flight lock are per instance, which is all a
 * serverless runtime can offer, and they are worth having because they smooth the
 * common case of somebody clicking repeatedly.
 *
 * The spend ceiling cannot work that way. Module state resets on every cold
 * start, so a counter of what this deployment has spent reads zero again the
 * moment the instance is recycled, and a cap built on it is not a cap at all. The
 * only number that survives a cold start is the one on the chain, so the real
 * floor is the agent's own balance: below the reserve, live settlement is simply
 * not offered. That holds however many instances are running.
 *
 * Anything a guard blocks still runs, just simulated, so a judge always sees the
 * loop work rather than an error.
 */
const MIN_LIVE_GAP_MS = 15_000;
/** Stop settling live once the wallet falls to this, so the demo cannot drain itself. */
const RESERVE_UNITS = 5_000_000n; // $5 of testnet USDC
/** Re-reading the balance every click would be its own rate-limit problem. */
const BALANCE_TTL_MS = 60_000;

let lastLiveRunAt = 0;
let liveRunInFlight = false;
let balanceCheckedAt = 0;
let lastKnownUnits = 0n;

/** The agent's on-chain balance, cached briefly. Cheap enough, and it is the truth. */
async function agentUnits(provider: ArcEoaSettlementProvider): Promise<bigint> {
  if (Date.now() - balanceCheckedAt < BALANCE_TTL_MS) return lastKnownUnits;
  try {
    lastKnownUnits = await provider.balanceUnits();
    balanceCheckedAt = Date.now();
  } catch {
    // If the balance cannot be read, assume the worst and stay simulated.
    lastKnownUnits = 0n;
    balanceCheckedAt = Date.now();
  }
  return lastKnownUnits;
}

function liveRunPermitted(): boolean {
  if (!arcKeyConfigured() || !LIVE_PROVIDER) return false;
  if (liveRunInFlight) return false;
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

  let provider: SettlementProvider = new MockSettlementProvider();
  let agentWallet = "agent-alpha-wallet";
  let heldBack: string | undefined;

  if (liveRunPermitted()) {
    try {
      const arc = new ArcEoaSettlementProvider();
      const units = await agentUnits(arc);
      if (units >= RESERVE_UNITS) {
        provider = arc;
        agentWallet = arc.address;
      } else {
        // Not an error. The wallet is down to its reserve, so the demo keeps
        // working and says why it is not spending.
        heldBack = "the agent's wallet is at its reserve, so this run was simulated";
      }
    } catch {
      // No usable key after all. Run simulated rather than fail the request.
    }
  }

  const settlingLive = !provider.mock;
  const payTo = settlingLive && LIVE_PROVIDER ? LIVE_PROVIDER : SIMULATED_PROVIDER;

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
      // The wallet just moved, so the cached balance is stale by definition.
      balanceCheckedAt = 0;
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
    heldBack,
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
