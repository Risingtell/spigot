/**
 * Spigot live runner - real USDC settlement on Arc.
 *
 *   npm run agent
 *
 * The same agent loop as the demo, with MockSettlementProvider replaced by
 * ArcSettlementProvider, so every settlement is a real confirmed USDC transfer
 * from the agent's Circle wallet to the provider on Arc Testnet. The cadence is
 * set by Arc's live fee market, so the agent never hands the chain more than a
 * few percent of what it moves. Requires, in .env.local:
 *
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID
 *   SPIGOT_AGENT_WALLET_ID   - the agent's funded Circle wallet id (holds USDC)
 *   SPIGOT_PROVIDER_ADDRESS  - the provider's Arc address to receive settlement
 */

import { MemoryStore, StreamingMeter } from "meter402";
import { ArcSettlementProvider } from "./arc-provider";
import { StreamingAgent, type TickContext } from "./agent";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "./arc";
import { circleConfigured } from "./circle-wallet";
import { economicSettlementSeconds, fetchSettlementCost, minEconomicSettlementUnits } from "./arc-gas";

const RATE_PER_SECOND = "50000"; // $0.05/sec
const MAX_OVERHEAD_RATIO = 0.05;

async function main(): Promise<void> {
  if (!circleConfigured()) {
    console.error("Circle is not configured. Set CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_WALLET_SET_ID in .env.local.");
    console.error("To try the flow with no keys, run:  npm run demo");
    process.exitCode = 1;
    return;
  }

  const agentWalletId = process.env.SPIGOT_AGENT_WALLET_ID;
  const providerAddress = process.env.SPIGOT_PROVIDER_ADDRESS;
  if (!agentWalletId || !providerAddress) {
    console.error("Set SPIGOT_AGENT_WALLET_ID (funded) and SPIGOT_PROVIDER_ADDRESS in .env.local.");
    process.exitCode = 1;
    return;
  }

  const store = new MemoryStore([
    {
      id: "inference-stream",
      title: "Low-latency inference capacity",
      ratePerSecond: RATE_PER_SECOND,
      asset: "USDC",
      provider: "NimbusCompute",
      payTo: providerAddress,
    },
  ]);

  const meter = new StreamingMeter(store, {
    payTo: providerAddress,
    maxTickSeconds: 60,
    network: ARC_TESTNET_CAIP2,
  });

  const cost = await fetchSettlementCost();
  const minSettle = minEconomicSettlementUnits(cost.costUnits, MAX_OVERHEAD_RATIO);

  console.log("Spigot - LIVE on Arc Testnet. Each settlement is a real USDC transfer.\n");
  console.log(`  gas price:       ${cost.gasPriceGwei.toFixed(4)} gwei  (${cost.source})`);
  console.log(`  one settlement:  $${unitsToUsdc(cost.costUnits).toFixed(6)} USDC`);
  console.log(
    `  cadence:         settle at $${unitsToUsdc(minSettle.toString()).toFixed(6)} and up, about every ${economicSettlementSeconds(minSettle, RATE_PER_SECOND).toFixed(2)}s\n`,
  );

  const agent = new StreamingAgent(meter, new ArcSettlementProvider(), agentWalletId, {
    budgetUnits: "600000", // $0.60 hard cap
    maxRatePerSecondUnits: "100000",
    objective: "Hold inference capacity only while it is worth more than it costs.",
    settlement: { costUnits: cost.costUnits, maxOverheadRatio: MAX_OVERHEAD_RATIO },
  });

  const valueSignal = (ctx: TickContext): number => {
    const factor = 1.9 - 0.1 * ctx.tick;
    return Number(ctx.marginalUnits) * factor;
  };

  const result = await agent.stream("inference-stream", {
    valueSignal,
    tickIntervalMs: 1000,
    maxTicks: 30,
  });

  console.log(`\nThe agent ruled on ${result.ticksMetered} intervals and settled ${result.settlements} times.`);
  console.log(`  reason it stopped: ${result.closedReason}`);
  console.log(`  paid:              $${unitsToUsdc(result.spentUnits).toFixed(6)} USDC on Arc\n`);

  for (const e of meter.impact().recent) {
    console.log(`  ${e.seconds.toFixed(2)}s held  ->  $${unitsToUsdc(e.amount).toFixed(6)}  ${e.explorerUrl}`);
  }

  console.log("\nRe-derive all of it from the chain:  npm run verify");
}

await main();
