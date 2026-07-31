/**
 * Spigot on Circle Nanopayments.
 *
 *   npm run nano
 *
 * The same agent, the same policy, a different rail. On the direct on-chain path
 * (`npm run agent`) every settlement is a transaction, so the agent has to batch
 * blocks up to roughly three cents before settling is worth the gas. Through
 * Gateway the signature is off-chain and the settlement is batched by Circle, so
 * the agent can settle every single tick at a fraction of a cent.
 *
 * What does not change is the part that matters: the budget, the rate ceiling and
 * the value signal. Those are Spigot, and they are enforced twice here, once in
 * the agent loop and once inside Gateway's own pre-signature hook.
 *
 * The value signal is real. The agent samples live BTC spot, measures how much
 * the market is actually moving, and keeps buying only while that movement is
 * worth the price. A flat market closes the gate.
 *
 * Needs, in .env.local: SPIGOT_ARC_KEY (funded on Arc) and
 * SPIGOT_PROVIDER_ADDRESS. Needs the seller running: `npm run dev`.
 */

import { MemoryStore, StreamingMeter } from "meter402";
import { StreamingAgent, type TickContext } from "./agent";
import { NanoSettlementProvider, nanoConfigured } from "./nano";
import { ACTIVE_MARKET_TRADES_PER_SECOND, MarketWindow, blockValueUnits, fetchTicker } from "./market";
import { streamById } from "./streams";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "./arc";
import { startRpcProxy } from "./rpc-proxy";

const SELLER = process.env.SPIGOT_SELLER_URL ?? "http://localhost:3000";
const BUDGET_UNITS = "400000"; // $0.40
const MAX_TICKS = 20;

async function main(): Promise<void> {
  const providerAddress = process.env.SPIGOT_PROVIDER_ADDRESS;
  if (!nanoConfigured() || !providerAddress) {
    console.error("Set SPIGOT_ARC_KEY and SPIGOT_PROVIDER_ADDRESS in .env.local.");
    console.error("Generate both with:  npm run wallet:new");
    process.exitCode = 1;
    return;
  }

  const stream = streamById("btc-risk-feed");
  if (!stream) throw new Error("btc-risk-feed is not in the stream catalogue.");

  const budget = BigInt(BUDGET_UNITS);
  let spent = 0n;

  // Gateway's own hook carries the same budget the agent enforces. A block the
  // policy refuses never becomes a signature.
  // Arc's public RPC caps concurrency, and the Gateway SDK fans out reads while
  // preparing a deposit. Point it at a pacing proxy instead of the raw endpoint.
  const proxy = await startRpcProxy();

  const settlement = new NanoSettlementProvider({
    sellerBaseUrl: SELLER,
    rpcUrl: proxy.url,
    policyCheck: (amountUnits) => {
      const amount = BigInt(amountUnits);
      if (amount <= 0n) return "a block must owe something";
      if (spent + amount > budget) return `block of ${amount} would breach the ${budget} budget`;
      return null;
    },
  });

  console.log("Spigot on Circle Nanopayments, Arc Testnet\n");
  console.log(`  agent   : ${settlement.address}`);
  console.log(`  provider: ${providerAddress}`);
  console.log(`  seller  : ${SELLER}\n`);

  const wallet = await settlement.walletUnits();
  console.log(`  wallet balance : $${unitsToUsdc(wallet.toString()).toFixed(6)} USDC`);

  const funded = await settlement.ensureFunded();
  if (funded.deposited) {
    console.log(`  deposited into Gateway, tx ${funded.txHash}`);
  }
  console.log(`  gateway balance: $${unitsToUsdc(funded.availableUnits.toString()).toFixed(6)} USDC available\n`);

  const store = new MemoryStore([
    {
      id: stream.id,
      title: stream.title,
      description: stream.description,
      ratePerSecond: stream.ratePerSecond,
      asset: "USDC",
      provider: stream.provider,
      payTo: providerAddress,
    },
  ]);

  const meter = new StreamingMeter(store, {
    payTo: providerAddress,
    maxTickSeconds: 60,
    network: ARC_TESTNET_CAIP2,
  });

  // No settlement economics: gas per block is zero on this rail, so there is
  // nothing to batch around and every metered interval can settle on its own.
  const agent = new StreamingAgent(meter, settlement, settlement.address, {
    budgetUnits: BUDGET_UNITS,
    maxRatePerSecondUnits: "100000",
    objective: "Hold the BTC risk feed only while the market is actually moving.",
  });

  // Observe before buying. One sample cannot express a rate of change, so the
  // agent watches the market briefly rather than ruling on an empty window.
  const window = new MarketWindow(12);
  console.log("  watching the market before opening the gate");
  for (let i = 0; i < 3; i++) {
    window.add(await fetchTicker());
    if (i < 2) await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(
    `  market is running at ${window.tradesPerSecond().toFixed(2)} trades/sec ` +
      `(a block is worth its full price at ${ACTIVE_MARKET_TRADES_PER_SECOND})
`,
  );
  let lastTps = window.tradesPerSecond();

  const valueSignal = async (ctx: TickContext): Promise<number> => {
    // Keep Gateway's pre-signature hook in step with what the agent has actually
    // settled. Without this the hook only ever sees zero spent, so it would catch
    // a single block bigger than the whole budget and nothing else, and the second
    // line of defence it is supposed to be would not exist.
    spent = ctx.spentUnits;
    try {
      window.add(await fetchTicker());
      lastTps = window.tradesPerSecond();
    } catch {
      // A missed sample is not a reason to change the decision; hold the last
      // reading rather than inventing a number in either direction.
    }
    const value = blockValueUnits({ tradesPerSecond: lastTps, costUnits: ctx.marginalUnits });
    const snap = window.snapshot();
    console.log(
      `  tick ${String(ctx.tick).padStart(2, "0")}  BTC $${snap.price?.toFixed(2) ?? "?"}  ` +
        `${lastTps.toFixed(2)} trades/sec  block ${unitsToUsdc(ctx.marginalUnits.toString()).toFixed(6)}  ` +
        `worth $${(value / 1e6).toFixed(6)}`,
    );
    return value;
  };

  const result = await agent.stream(stream.id, { valueSignal, tickIntervalMs: 1000, maxTicks: MAX_TICKS });

  console.log(`\nThe agent ruled on ${result.ticksMetered} intervals and settled ${result.settlements} times.`);
  console.log(`  reason it stopped: ${result.closedReason}`);
  console.log(`  paid:              $${unitsToUsdc(result.spentUnits).toFixed(6)} USDC, gas free\n`);

  for (const e of meter.impact().recent.slice().reverse()) {
    console.log(`  ${e.seconds.toFixed(2)}s held  ->  $${unitsToUsdc(e.amount).toFixed(6)}  ${e.txHash}`);
  }

  const left = await settlement.gatewayUnits();
  console.log(`\nGateway balance now $${unitsToUsdc(left.toString()).toFixed(6)} USDC.`);
  console.log("Every block above was signed off-chain and batched by Circle. No gas was paid per block.");

  const p = proxy.stats();
  console.log(`RPC proxy: ${p.forwarded} calls forwarded, ${p.retried} retried through throttling, ${p.failed} failed.`);
  await proxy.close();
}

await main();
