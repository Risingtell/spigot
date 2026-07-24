/**
 * Spigot live runner - real USDC settlement on Arc.
 *
 *   npm run agent
 *
 * Identical agent loop to the demo, but the MockSettlementProvider is replaced by
 * ArcSettlementProvider, so every tick is a real, confirmed USDC transfer from the
 * agent's Circle wallet to the provider on Arc Testnet. Requires, in .env.local:
 *
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID
 *   SPIGOT_AGENT_WALLET_ID   - the agent's funded Circle wallet id (holds USDC)
 *   SPIGOT_PROVIDER_ADDRESS  - the provider's Arc address to receive settlement
 */

import { MemoryStore, StreamingMeter } from "meter402";
import { ArcSettlementProvider } from "./arc-provider.js";
import { StreamingAgent, type TickContext } from "./agent.js";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "./arc.js";
import { circleConfigured } from "./circle-wallet.js";

if (!circleConfigured()) {
  console.error("Circle is not configured. Set CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_WALLET_SET_ID in .env.local.");
  console.error("To try the flow with no keys or chain, run:  npm run demo");
  process.exit(1);
}

const agentWalletId = process.env.SPIGOT_AGENT_WALLET_ID;
const providerAddress = process.env.SPIGOT_PROVIDER_ADDRESS;
if (!agentWalletId || !providerAddress) {
  console.error("Set SPIGOT_AGENT_WALLET_ID (funded) and SPIGOT_PROVIDER_ADDRESS in .env.local.");
  process.exit(1);
}

const store = new MemoryStore([
  {
    id: "btc-risk-feed",
    title: "BTC liquidation-risk feed",
    ratePerSecond: "1000", // $0.001/sec
    asset: "USDC",
    provider: "RiskLabs",
    payTo: providerAddress,
  },
]);

const meter = new StreamingMeter(store, {
  payTo: providerAddress,
  maxTickSeconds: 10,
  network: ARC_TESTNET_CAIP2,
});

const provider = new ArcSettlementProvider();

const agent = new StreamingAgent(meter, provider, agentWalletId, {
  budgetUnits: "50000", // $0.05 hard cap
  maxRatePerSecondUnits: "5000",
  objective: "Hold the BTC risk feed only while its edge beats the price.",
});

const valueSignal = (ctx: TickContext): number => {
  const cost = Number(ctx.quote.amount);
  return cost * (1.8 - 0.25 * ctx.tick);
};

console.log("Spigot - LIVE on Arc Testnet. Each tick is a real USDC transfer.\n");

const result = await agent.stream("btc-risk-feed", { valueSignal, tickIntervalMs: 1000, maxTicks: 20 });

console.log(`\nAgent paid ${result.ticksPaid} ticks, then stopped: ${result.closedReason}`);
console.log(`Spent $${unitsToUsdc(result.spentUnits).toFixed(6)} USDC on Arc.`);

for (const e of meter.impact().recent) {
  console.log(`  tick ${e.seconds.toFixed(2)}s → $${unitsToUsdc(e.amount).toFixed(6)}  ${e.explorerUrl}`);
}
