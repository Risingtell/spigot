/**
 * Spigot end-to-end demo - runs offline in MOCK mode (no keys, no chain).
 *
 *   npm run demo
 *
 * A provider lists a metered data feed on Arc. An autonomous agent streams it and
 * pays per second in USDC - until the feed's marginal value drops below what the
 * next second costs, at which point the agent shuts its own gate and records why.
 * Swap MockSettlementProvider for ArcSettlementProvider (see src/run-live.ts) and
 * every tick below becomes a real confirmed USDC transfer on Arc, unchanged.
 */

import { MemoryStore, MockSettlementProvider, StreamingMeter } from "meter402";
import { StreamingAgent, type TickContext } from "../src/agent.js";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "../src/arc.js";

// A provider lists one metered stream, priced per second in USDC smallest units.
// 1000 units/sec = $0.001/sec.
const store = new MemoryStore([
  {
    id: "btc-risk-feed",
    title: "BTC liquidation-risk feed",
    description: "Streaming liquidation-risk signal for BTC perps.",
    ratePerSecond: "1000",
    asset: "USDC",
    provider: "RiskLabs",
    payTo: "0xProviderTreasuryAddress0000000000000000",
  },
]);

const meter = new StreamingMeter(store, {
  payTo: "0xProviderTreasuryAddress0000000000000000",
  maxTickSeconds: 10,
  network: ARC_TESTNET_CAIP2,
});

// In mock mode the "wallet id" is just a label; live, it's the agent's Circle wallet.
const provider = new MockSettlementProvider();

const agent = new StreamingAgent(meter, provider, "agent-alpha-wallet", {
  budgetUnits: "50000", //     $0.05 hard cap
  maxRatePerSecondUnits: "5000", // won't touch a feed pricier than $0.005/sec
  objective: "Hold the BTC risk feed only while its edge beats the price.",
});

// The agent's real-signal decision input: the marginal value it places on the
// next chunk. Here the feed's edge decays each tick - so the agent will keep
// paying while the signal is fresh, then stop itself when it isn't.
const valueSignal = (ctx: TickContext): number => {
  const cost = Number(ctx.quote.amount);
  const factor = 1.8 - 0.25 * ctx.tick; // 1.55x cost, decaying below 1x by tick 4
  return cost * factor;
};

console.log("Spigot - agent-native streaming settlement on Arc (MOCK mode)\n");

const result = await agent.stream("btc-risk-feed", {
  valueSignal,
  tickIntervalMs: 250,
  maxTicks: 20,
});

const snapshot = meter.impact();

console.log(`Agent paid ${result.ticksPaid} ticks, then stopped.`);
console.log(`  reason:  ${result.closedReason}`);
console.log(`  spent:   $${unitsToUsdc(result.spentUnits).toFixed(6)} USDC`);
console.log(`  budget:  $0.050000 USDC (untouched remainder stays with the agent)\n`);

console.log("Proof feed (meter402 impact snapshot - never over-claims):");
console.log(`  settlements:     ${snapshot.totals.settlements}`);
console.log(`  total settled:   $${unitsToUsdc(snapshot.totals.totalPaid).toFixed(6)} USDC`);
console.log(`  seconds streamed: ${snapshot.totals.secondsStreamed.toFixed(2)}s`);
console.log(`  unique agents:   ${snapshot.totals.uniqueAgents}`);
console.log(`  network:         ${snapshot.network}\n`);

console.log("Recorded autonomous decisions:");
for (const d of snapshot.decisions) {
  console.log(`  ${d.agent} closed "${d.streamId}" after ${d.ticks} ticks - ${d.closedReason}`);
}
