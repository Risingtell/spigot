/**
 * Spigot live runner - real USDC settlement on Arc.
 *
 *   npm run agent
 *
 * The same agent loop as the demo, settling for real: every settlement is a
 * confirmed USDC transfer to the provider on Arc Testnet, and the cadence is set by
 * Arc's live fee market so the chain never takes more than a few percent of what it
 * moves. Requires, in .env.local:
 *
 *   SPIGOT_PROVIDER_ADDRESS  - the Arc address that receives settlement
 *
 * plus one way for the agent to pay. Either a plain Arc key, which is the quickest:
 *
 *   SPIGOT_ARC_KEY           - a key holding USDC, funded at faucet.circle.com
 *
 * or Circle developer-controlled wallets:
 *
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID
 *   SPIGOT_AGENT_WALLET_ID   - the agent's funded Circle wallet id
 */

import { MemoryStore, StreamingMeter, type SettlementProvider } from "meter402";
import { ArcSettlementProvider } from "./arc-provider";
import { ArcEoaSettlementProvider, arcKeyConfigured } from "./arc-eoa";
import { StreamingAgent, type TickContext } from "./agent";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "./arc";
import { circleConfigured } from "./circle-wallet";
import { economicSettlementSeconds, fetchSettlementCost, minEconomicSettlementUnits } from "./arc-gas";

const RATE_PER_SECOND = "50000"; // $0.05/sec
const MAX_OVERHEAD_RATIO = 0.05;

async function main(): Promise<void> {
  const providerAddress = process.env.SPIGOT_PROVIDER_ADDRESS;
  if (!providerAddress) {
    console.error("Set SPIGOT_PROVIDER_ADDRESS in .env.local - the Arc address that receives settlement.");
    process.exitCode = 1;
    return;
  }

  // Two ways to hold funds on Arc, and the agent will take whichever is configured.
  // A plain key is the shortest route: fund it from faucet.circle.com and go. Circle
  // developer-controlled wallets are the route with an organisation behind them.
  let settlement: SettlementProvider;
  let agentWallet: string;
  if (arcKeyConfigured()) {
    const arc = new ArcEoaSettlementProvider();
    settlement = arc;
    agentWallet = arc.address;
    const balance = await arc.balanceUnits();
    console.log(`Agent key ${arc.address} holds $${unitsToUsdc(balance.toString()).toFixed(6)} USDC on Arc.`);
    if (balance === 0n) {
      console.error("That wallet has no USDC. Fund it at https://faucet.circle.com and run this again.");
      process.exitCode = 1;
      return;
    }
  } else if (circleConfigured() && process.env.SPIGOT_AGENT_WALLET_ID) {
    settlement = new ArcSettlementProvider();
    agentWallet = process.env.SPIGOT_AGENT_WALLET_ID;
  } else {
    console.error("No way to pay. Set either:");
    console.error("  SPIGOT_ARC_KEY                                     - an Arc key holding USDC, or");
    console.error("  CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_WALLET_SET_ID + SPIGOT_AGENT_WALLET_ID");
    console.error("To watch the flow with no funds at all, run:  npm run demo");
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

  const agent = new StreamingAgent(meter, settlement, agentWallet, {
    budgetUnits: "600000", // $0.60 hard cap
    maxRatePerSecondUnits: "100000",
    objective: "Hold inference capacity only while it is worth more than it costs.",
    settlement: { costUnits: cost.costUnits, maxOverheadRatio: MAX_OVERHEAD_RATIO, meterMaxTickSeconds: 60 },
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
