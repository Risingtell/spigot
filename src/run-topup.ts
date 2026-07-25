/**
 * Cross-chain top-up runner - the agent refilling its own Arc wallet.
 *
 *   npm run topup
 *
 * Reads the agent's live USDC balance on Arc, applies the treasury policy, and if
 * the balance has fallen below the floor, bridges USDC in from the reserve chain
 * over CCTP. Requires, in .env.local:
 *
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID
 *   SPIGOT_AGENT_WALLET_ID    - the agent's Circle wallet on Arc (the balance read)
 *   SPIGOT_AGENT_ADDRESS      - that wallet's Arc address (the mint recipient)
 *   SPIGOT_RESERVE_KEY        - key controlling the reserve on the source chain
 *   SPIGOT_RESERVE_CHAIN      - optional, defaults to Base_Sepolia
 */

import { getUsdc, circleConfigured } from "./circle-wallet";
import { planTopUp, topUpArc, treasuryPolicy, type ReserveChain } from "./treasury";
import { usdcToUnits } from "./arc";

const agentWalletId = process.env.SPIGOT_AGENT_WALLET_ID;
const arcAddress = process.env.SPIGOT_AGENT_ADDRESS;
const reserveKey = process.env.SPIGOT_RESERVE_KEY;
const reserveChain = (process.env.SPIGOT_RESERVE_CHAIN as ReserveChain | undefined) ?? "Base_Sepolia";

async function main(): Promise<void> {
  if (!circleConfigured() || !agentWalletId || !arcAddress) {
    console.error("Set CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_WALLET_SET_ID,");
    console.error("plus SPIGOT_AGENT_WALLET_ID and SPIGOT_AGENT_ADDRESS, in .env.local.");
    process.exitCode = 1;
    return;
  }

  const policy = treasuryPolicy({ floorUsdc: 0.5, targetUsdc: 2, reserveChain });

  const { amount } = await getUsdc(agentWalletId);
  const plan = planTopUp(usdcToUnits(amount), policy);

  console.log("Spigot treasury check");
  console.log(`  agent on Arc:  ${arcAddress}`);
  console.log(`  balance:       $${amount.toFixed(6)} USDC`);
  console.log(`  decision:      ${plan.needed ? "top up" : "hold"} - ${plan.reason}\n`);

  if (!plan.needed) return;

  if (!reserveKey) {
    console.error(`Would bridge $${plan.amountUsdc} USDC from ${reserveChain}, but SPIGOT_RESERVE_KEY is not set.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Bridging $${plan.amountUsdc} USDC from ${reserveChain} to Arc over CCTP.\n`);

  const result = await topUpArc({
    reservePrivateKey: reserveKey,
    arcAddress,
    policy,
    amountUsdc: plan.amountUsdc,
    onStep: (step) => {
      const link = step.explorerUrl ? `  ${step.explorerUrl}` : "";
      console.log(`  ${step.name}: ${step.state}${link}`);
    },
  });

  console.log(`\nBridge ${result.state}. Steps:`);
  for (const step of result.steps) {
    console.log(`  ${step.name}: ${step.state}${step.explorerUrl ? `  ${step.explorerUrl}` : ""}`);
  }

  if (result.state !== "success") process.exitCode = 1;
}

await main();
