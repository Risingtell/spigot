/**
 * Spigot end-to-end demo - runs with no keys and no wallet.
 *
 *   npm run demo
 *
 * A provider lists a metered inference stream on Arc. An autonomous agent holds it
 * and pays for it in USDC - deciding every tick whether the next slice is still
 * worth its price, and settling on-chain only when the amount owed is big enough
 * that Arc's fee is a rounding error against it. When the stream's value decays
 * below its cost, the agent shuts its own gate, pays off what it owes, and says
 * why.
 *
 * Settlement here is simulated (MockSettlementProvider), but the fee that drives
 * the cadence is not: it is read live from Arc's public RPC. Swap in
 * ArcSettlementProvider (see src/run-live.ts) and every settlement below becomes a
 * real confirmed USDC transfer, unchanged.
 */

import { MemoryStore, MockSettlementProvider, StreamingMeter } from "meter402";
import { StreamingAgent, type TickContext } from "../src/agent";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "../src/arc";
import { economicSettlementSeconds, fetchSettlementCost, minEconomicSettlementUnits } from "../src/arc-gas";

const RATE_PER_SECOND = "50000"; // $0.05/sec of held inference capacity
const MAX_OVERHEAD_RATIO = 0.05; // the chain may take 5% of what it moves, no more
const PROVIDER = "0xProviderTreasuryAddress0000000000000000";

const store = new MemoryStore([
  {
    id: "inference-stream",
    title: "Low-latency inference capacity",
    description: "Reserved model capacity, billed for exactly the time it is held.",
    ratePerSecond: RATE_PER_SECOND,
    asset: "USDC",
    provider: "NimbusCompute",
    payTo: PROVIDER,
  },
]);

// maxTickSeconds has to cover a whole settlement window, or the meter would stop
// counting time the agent is still holding.
const meter = new StreamingMeter(store, {
  payTo: PROVIDER,
  maxTickSeconds: 60,
  network: ARC_TESTNET_CAIP2,
});

// What one settlement costs on Arc right now, straight from the fee market.
const cost = await fetchSettlementCost();
const minSettle = minEconomicSettlementUnits(cost.costUnits, MAX_OVERHEAD_RATIO);

console.log("Spigot - agent-native streaming settlement on Arc\n");
console.log("Arc fee market (live):");
console.log(`  gas price:        ${cost.gasPriceGwei.toFixed(4)} gwei  (${cost.source})`);
console.log(`  one settlement:   $${unitsToUsdc(cost.costUnits).toFixed(6)} USDC`);
console.log(`  worth settling:   $${unitsToUsdc(minSettle.toString()).toFixed(6)} and up, to keep the fee under 5%`);
console.log(
  `  which is:         about every ${economicSettlementSeconds(minSettle, RATE_PER_SECOND).toFixed(2)}s of this stream\n`,
);

const agent = new StreamingAgent(meter, new MockSettlementProvider(), "agent-alpha-wallet", {
  budgetUnits: "600000", //          $0.60 hard cap
  maxRatePerSecondUnits: "100000", // will not touch capacity pricier than $0.10/sec
  objective: "Hold inference capacity only while it is worth more than it costs.",
  settlement: { costUnits: cost.costUnits, maxOverheadRatio: MAX_OVERHEAD_RATIO },
});

// The agent's real-signal decision input: what the next slice is worth to it right
// now. Here the value of holding the capacity decays as its queue drains, so the
// agent keeps paying while the work is there and stops itself when it is not.
const valueSignal = (ctx: TickContext): number => {
  const factor = 1.9 - 0.1 * ctx.tick; // dips under 1x cost around tick 10
  return Number(ctx.marginalUnits) * factor;
};

const result = await agent.stream("inference-stream", {
  valueSignal,
  tickIntervalMs: 250,
  maxTicks: 40,
});

const snapshot = meter.impact();

console.log(`The agent ruled on ${result.ticksMetered} intervals and settled ${result.settlements} times.`);
console.log(`  reason it stopped:  ${result.closedReason}`);
console.log(`  paid:               $${unitsToUsdc(result.spentUnits).toFixed(6)} USDC`);
console.log(`  budget:             $0.600000 USDC (the remainder stays with the agent)`);

if (result.settlements > 0) {
  const perSettlement = Number(result.spentUnits) / result.settlements;
  const share = (Number(cost.costUnits) / perSettlement) * 100;
  console.log(`  average settlement: $${(perSettlement / 1e6).toFixed(6)} USDC`);
  console.log(`  chain fee took:     ${share.toFixed(2)}% of each one\n`);
}

console.log("Proof feed (meter402 impact snapshot - never over-claims):");
console.log(`  settlements:        ${snapshot.totals.settlements}`);
console.log(`  total settled:      $${unitsToUsdc(snapshot.totals.totalPaid).toFixed(6)} USDC`);
console.log(`  seconds streamed:   ${snapshot.totals.secondsStreamed.toFixed(2)}s`);
console.log(`  network:            ${snapshot.network}\n`);

console.log("Recorded autonomous decisions:");
for (const d of snapshot.decisions) {
  console.log(`  ${d.agent} closed "${d.streamId}" after ${d.ticks} settlements - ${d.closedReason}`);
}
