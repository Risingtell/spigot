import { NextResponse } from "next/server";
import { MemoryStore, MockSettlementProvider, StreamingMeter, type SettlementProvider } from "meter402";
import { StreamingAgent, type TickContext } from "@/src/agent";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "@/src/arc";
import { economicSettlementSeconds, fetchSettlementCost, minEconomicSettlementUnits } from "@/src/arc-gas";
import { ArcEoaSettlementProvider, arcKeyConfigured } from "@/src/arc-eoa";
import { NanoSettlementProvider, nanoConfigured } from "@/src/nano";
import { MarketWindow, activityTarget, blockValueUnits, fetchTicker } from "@/src/market";
import { streamById } from "@/src/streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The gas-free rail primes a market window and then buys once a second. */
export const maxDuration = 60;

/**
 * Runs the real Spigot agent loop so anyone can click and watch an autonomous agent
 * hold a metered stream, pay for it, and shut its own gate.
 *
 * Two rails, one agent. On the direct rail every settlement is a confirmed USDC
 * transfer on Arc with an explorer link, and the agent has to batch because the
 * chain fee is real. On the gas-free rail it signs off-chain, Circle Gateway
 * settles and batches, and the agent buys every single tick at a fraction of a
 * cent - and the response to each payment IS the next chunk of the stream, so the
 * gate is the payment rather than something layered over it.
 *
 * The budget, the rate ceiling and the value signal do not change between them.
 * That is the entire point: the rail decides what a payment costs, the agent
 * decides whether it is worth making.
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
 */
const MIN_LIVE_GAP_MS = 15_000;
/** Stop settling live once the wallet falls to this, so the demo cannot drain itself. */
const RESERVE_UNITS = 5_000_000n; // $5 of testnet USDC
/** The same idea for the Gateway balance the gas-free rail spends from. */
const GATEWAY_RESERVE_UNITS = 200_000n; // $0.20
/** Re-reading the balance every click would be its own rate-limit problem. */
const BALANCE_TTL_MS = 60_000;

let lastLiveRunAt = 0;
let liveRunInFlight = false;
let balanceCheckedAt = 0;
let lastKnownUnits = 0n;

/** The gas-free rail spends from the same Gateway balance on every run, so it
 * needs the same lock and pacing the direct rail has, or nothing stops one
 * click count from turning into several concurrent draws against it. */
let lastNanoRunAt = 0;
let nanoRunInFlight = false;

function nanoRunPermitted(): boolean {
  if (nanoRunInFlight) return false;
  return Date.now() - lastNanoRunAt >= MIN_LIVE_GAP_MS;
}

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

/** Shape shared by both rails, so the page renders one thing either way. */
function settlementRows(events: { amount: string; seconds: number; txHash: string; explorerUrl?: string }[], costUnits: string) {
  let cumulative = 0n;
  return events.map((e, i) => {
    cumulative += BigInt(e.amount);
    return {
      n: i + 1,
      seconds: e.seconds,
      amountUsd: unitsToUsdc(e.amount),
      cumulativeUsd: unitsToUsdc(cumulative.toString()),
      // What Arc's fee took out of this one settlement. Zero on the gas-free rail.
      feeSharePct: Number(costUnits) === 0 ? 0 : (Number(costUnits) / Number(e.amount)) * 100,
      txHash: e.txHash,
      explorerUrl: e.explorerUrl,
    };
  });
}

// ---------------------------------------------------------------------------
// The gas-free rail: the agent buys a real market feed from Spigot's own seller
// ---------------------------------------------------------------------------

const NANO_BUDGET_UNITS = "400000"; // $0.40
const NANO_MAX_TICKS = 8;

/**
 * The gas-free rail offers the same choice the direct rail does, for the same
 * reason: what a judge needs to see is the policy, and the policy is only visible
 * when you can vary the thing it rules on.
 *
 * `live` is the real one and the default. It hands the agent the actual BTC trade
 * flow and lets the decision fall where it falls, which means the number of blocks
 * it buys depends on what the market is doing at the moment of the click. That is
 * the product working, not a flaw, but it does mean a quiet hour produces a short
 * run. The scenario curves are the same stated value curves the direct rail uses,
 * so the rail itself can be watched settling repeatedly regardless of the market.
 */
async function runNano(origin: string, scenario: Scenario | null) {
  const stream = streamById("btc-risk-feed");
  if (!stream) throw new Error("btc-risk-feed is not in the stream catalogue.");
  if (!LIVE_PROVIDER) return { unavailable: "this deployment has no provider address configured" };
  if (!nanoConfigured()) return { unavailable: "this deployment holds no agent key, so nothing can be signed" };
  if (!nanoRunPermitted()) {
    return { unavailable: "another run is already in flight on this rail, or the last one finished too recently" };
  }

  // Taken synchronously, before the first await, so a second request arriving
  // while this one is still reading the Gateway balance sees the lock rather
  // than racing it to spend against the same starting balance.
  nanoRunInFlight = true;
  lastNanoRunAt = Date.now();
  try {
    return await runNanoBody(origin, scenario, stream, LIVE_PROVIDER);
  } finally {
    nanoRunInFlight = false;
  }
}

async function runNanoBody(
  origin: string,
  scenario: Scenario | null,
  stream: NonNullable<ReturnType<typeof streamById>>,
  payTo: string,
) {
  const budget = BigInt(NANO_BUDGET_UNITS);
  let spent = 0n;

  const settlement = new NanoSettlementProvider({
    sellerBaseUrl: origin,
    // Gateway's own hook, carrying the same budget the agent enforces, so no code
    // path can pay around the policy. Kept in step with what has actually settled.
    policyCheck: (amountUnits) => {
      const amount = BigInt(amountUnits);
      if (amount <= 0n) return "a block must owe something";
      if (spent + amount > budget) return `block of ${amount} would breach the ${budget} budget`;
      return null;
    },
  });

  const available = await settlement.gatewayUnits();
  if (available < GATEWAY_RESERVE_UNITS) {
    return {
      unavailable: `the agent's Gateway balance is down to $${unitsToUsdc(available.toString()).toFixed(6)}, below the reserve it keeps`,
    };
  }

  const store = new MemoryStore([
    {
      id: stream.id,
      title: stream.title,
      description: stream.description,
      ratePerSecond: stream.ratePerSecond,
      asset: "USDC",
      provider: stream.provider,
      payTo,
    },
  ]);
  const meter = new StreamingMeter(store, { payTo, maxTickSeconds: 60, network: ARC_TESTNET_CAIP2 });

  // No settlement economics: gas per block is zero on this rail, so there is
  // nothing to batch around and every metered interval can settle on its own.
  const agent = new StreamingAgent(meter, settlement, settlement.address, {
    budgetUnits: NANO_BUDGET_UNITS,
    maxRatePerSecondUnits: "100000",
    objective: "Hold the BTC risk feed only while the market is actually moving.",
  });

  /**
   * Observe before buying, and long enough for the reading to mean something. One
   * sample cannot express a rate at all, and a rate of well under one trade a
   * second cannot be estimated across a second and a half, so the window is primed
   * over about four seconds and that measurement becomes the bar the rest of the
   * run is held to.
   */
  const window = new MarketWindow(12);
  for (let i = 0; i < 4; i++) {
    window.add(await fetchTicker());
    if (i < 3) await new Promise((r) => setTimeout(r, 1200));
  }
  const openedAt = window.tradesPerSecond();
  const target = activityTarget(openedAt);
  let lastTps = openedAt;

  const valueSignal = async (ctx: TickContext): Promise<number> => {
    spent = ctx.spentUnits;
    try {
      window.add(await fetchTicker());
      lastTps = window.tradesPerSecond();
    } catch {
      // A missed sample is not a reason to change the decision; hold the last
      // reading rather than inventing a number in either direction.
    }
    if (scenario) return Number(ctx.marginalUnits) * (scenario.base - scenario.slope * ctx.tick);
    return blockValueUnits({ tradesPerSecond: lastTps, costUnits: ctx.marginalUnits, fullValueTps: target });
  };

  const result = await agent.stream(stream.id, { valueSignal, tickIntervalMs: 1000, maxTicks: NANO_MAX_TICKS });
  const events = meter.impact().recent.slice().reverse();

  return {
    settlements: settlementRows(events, "0"),
    delivered: settlement.delivered.map((d, i) => ({ n: i + 1, ...d })),
    market: {
      openedAtTradesPerSecond: Number(openedAt.toFixed(2)),
      closedAtTradesPerSecond: Number(lastTps.toFixed(2)),
      /** The bar this run held itself to, measured before it bought anything. */
      targetTradesPerSecond: Number(target.toFixed(2)),
    },
    decision: {
      reason: result.closedReason,
      settlements: result.settlements,
      ticksMetered: result.ticksMetered,
      spentUsd: unitsToUsdc(result.spentUnits),
      feeSharePct: 0,
    },
    signal: scenario ? ("scenario" as const) : ("market" as const),
    scenario: {
      id: scenario?.id ?? "live",
      label: scenario ? scenario.label : "Live market signal",
      blurb: scenario
        ? `${scenario.blurb} Bought gas free, one second at a time, against the real BTC feed.`
        : "The agent buys a live BTC risk feed one second at a time, gas free, and holds it only while trade flow keeps up with what it measured before opening the gate. The response to each payment is the next chunk, so the gate is the payment.",
      ratePerSecondUsd: unitsToUsdc(stream.ratePerSecond),
      budgetUsd: unitsToUsdc(NANO_BUDGET_UNITS),
    },
  };
}

// ---------------------------------------------------------------------------
// The direct rail: every settlement is its own transaction on Arc
// ---------------------------------------------------------------------------

async function runDirect(scenario: Scenario) {
  let provider: SettlementProvider = new MockSettlementProvider();
  let agentWallet = "agent-alpha-wallet";
  let heldBack: string | undefined;

  // The lock is taken here, synchronously, before the first await below - not
  // after the balance check and fee read that follow. Two requests arriving
  // close together both read liveRunPermitted() before either awaited anything
  // once, which let both proceed live against the same wallet at once.
  let lockHeld = false;
  if (liveRunPermitted()) {
    liveRunInFlight = true;
    lockHeld = true;
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

  // Never went live after all: release the lock now rather than holding it for
  // a simulated run, which does not touch the wallet and is not what the lock
  // guards against.
  if (lockHeld && !settlingLive) liveRunInFlight = false;

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
  const meter = new StreamingMeter(store, { payTo, maxTickSeconds: 60, network: ARC_TESTNET_CAIP2 });

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

  // The lock itself was already taken above, before the balance and fee reads;
  // this only stamps the pacing clock, and only for a run that actually spends.
  if (settlingLive) lastLiveRunAt = Date.now();

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
  const spentUnits = Number(result.spentUnits);
  const feeSharePct = result.settlements > 0 ? (Number(cost.costUnits) * result.settlements * 100) / spentUnits : 0;

  return {
    mode: settlingLive ? ("live" as const) : ("simulated" as const),
    agent: settlingLive ? agentWallet : undefined,
    heldBack,
    settlements: settlementRows(events, cost.costUnits),
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
    decision: {
      reason: result.closedReason,
      settlements: result.settlements,
      ticksMetered: result.ticksMetered,
      spentUsd: unitsToUsdc(result.spentUnits),
      feeSharePct,
    },
  };
}

export async function POST(req: Request) {
  let scenarioId = "stale";
  let rail: "direct" | "nano" = "direct";
  let liveSignal = true;
  try {
    const body = (await req.json()) as { scenario?: string; rail?: string };
    if (body.rail === "nano") rail = "nano";
    if (body.scenario && SCENARIOS[body.scenario]) {
      scenarioId = body.scenario;
      liveSignal = false;
    }
  } catch {
    // no body - use the defaults
  }

  if (rail === "nano") {
    try {
      const nano = await runNano(new URL(req.url).origin, liveSignal ? null : SCENARIOS[scenarioId]);
      if ("unavailable" in nano) {
        // Say why rather than quietly running something else. A rail that is not
        // available is worth stating; a rail that pretends is worth nothing.
        return NextResponse.json({ rail, mode: "unavailable", reason: nano.unavailable }, { status: 200 });
      }
      return NextResponse.json({ rail, mode: "live", network: ARC_TESTNET_CAIP2, ...nano });
    } catch (err) {
      return NextResponse.json(
        { rail, mode: "unavailable", reason: (err as Error).message },
        { status: 200 },
      );
    }
  }

  const direct = await runDirect(SCENARIOS[scenarioId]);
  return NextResponse.json({ rail, network: ARC_TESTNET_CAIP2, ...direct });
}
