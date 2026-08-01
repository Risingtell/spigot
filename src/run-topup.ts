/**
 * The agent refilling its own Arc wallet.
 *
 *   npm run topup                  check the balance, draw if the policy says so
 *   npm run topup -- --fund 10     move 10 USDC from a chain into the unified balance
 *
 * Reads the agent's live USDC balance on Arc, applies the treasury policy, and if
 * the balance has fallen below its floor, draws the shortfall out of its unified
 * balance. No source chain is named anywhere below: Circle's auto-allocation reads
 * what the agent holds and decides which chains to pull from.
 *
 * Needs only what the rest of Spigot needs, in .env.local:
 *
 *   SPIGOT_ARC_KEY           - the agent's key, the same one that settles
 *   SPIGOT_AGENT_ADDRESS     - its Arc address, which receives the mint
 *
 * Optional: SPIGOT_RESERVE_CHAIN, the chain `--fund` deposits from (Base_Sepolia).
 */

import { ArcEoaSettlementProvider, arcKeyConfigured } from "./arc-eoa";
import {
  drawToArc,
  fundReserve,
  planTopUp,
  treasuryPolicy,
  unifiedBalance,
  type DepositChain,
  type ReserveChain,
} from "./treasury";
import { unitsToUsdc } from "./arc";

const reserveChain = (process.env.SPIGOT_RESERVE_CHAIN as ReserveChain | undefined) ?? "Base_Sepolia";
/** `--from <chain>` overrides where a deposit is taken from, Arc_Testnet included. */
const depositChain = (): DepositChain => {
  const i = process.argv.indexOf("--from");
  return i === -1 ? reserveChain : (process.argv[i + 1] as DepositChain);
};

/**
 * Explicit amounts for the two operator-facing moves, `--fund` in and `--draw`
 * out. With neither flag the agent runs its own policy and decides for itself,
 * which is the path that matters; these two exist so the capability can be
 * exercised on demand rather than only when a balance happens to be low.
 */
function amountFlag(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const amount = process.argv[i + 1];
  if (!amount || !(Number(amount) > 0)) throw new Error(`${flag} needs an amount in whole USDC, e.g. ${flag} 2`);
  return Number(amount).toFixed(6);
}

async function main(): Promise<void> {
  const key = process.env.SPIGOT_ARC_KEY;
  const arcAddress = process.env.SPIGOT_AGENT_ADDRESS;

  if (!arcKeyConfigured() || !key || !arcAddress) {
    console.error("Set SPIGOT_ARC_KEY and SPIGOT_AGENT_ADDRESS in .env.local.");
    console.error("Generate both with:  npm run wallet:new");
    process.exitCode = 1;
    return;
  }

  const deposit = amountFlag("--fund");
  if (deposit) {
    console.log(`Depositing $${deposit} USDC from ${depositChain()} into the agent's unified balance.\n`);
    await fundReserve({
      privateKey: key,
      chain: depositChain(),
      amountUsdc: deposit,
      onStep: (s) => console.log(`  ${s.name} on ${s.chain}`),
    });
    console.log("\nDeposited. From here it is not funds on a chain, it is the agent's balance.");
    return;
  }

  // What the agent can spend, everywhere, read from Circle rather than from us.
  const balance = await unifiedBalance(key);

  console.log("Spigot treasury\n");
  console.log(`  agent:            ${arcAddress}`);
  console.log(`  unified balance:  $${balance.totalUsd.toFixed(6)} USDC across ${balance.perChain.length} chain(s)`);
  for (const row of balance.perChain) {
    console.log(`     ${row.chain.padEnd(24)} $${row.usd.toFixed(6)}`);
  }

  // The floor is about the chain the agent settles on, so it is the Arc spending
  // balance that is measured, not the reserve.
  const onArc = await new ArcEoaSettlementProvider().balanceUnits();
  const policy = treasuryPolicy({ floorUsdc: 5, targetUsdc: 20, reserveChain });
  const plan = planTopUp(onArc.toString(), policy);
  const forced = amountFlag("--draw");

  console.log(`\n  spendable on Arc: $${unitsToUsdc(onArc.toString()).toFixed(6)} USDC`);
  console.log(`  decision:         ${plan.needed ? "draw" : "hold"} - ${plan.reason}\n`);

  if (!plan.needed && !forced) {
    console.log("Nothing to do. The agent tops itself up only when it has to.");
    console.log("To exercise the draw anyway:  npm run topup -- --draw 2");
    return;
  }
  if (forced && !plan.needed) {
    console.log(`Drawing $${forced} anyway, because --draw was asked for.\n`);
  }
  plan.amountUsdc = forced ?? plan.amountUsdc;

  if (BigInt(balance.totalUnits) <= 0n) {
    console.error("The unified balance is empty, so there is nothing to draw from.");
    console.error(`Fund it first:  npm run topup -- --fund 10   (from ${reserveChain})`);
    process.exitCode = 1;
    return;
  }

  console.log(`Drawing $${plan.amountUsdc} USDC onto Arc. Auto-allocation picks the source chains.\n`);

  const result = await drawToArc({
    privateKey: key,
    arcAddress,
    amountUsdc: plan.amountUsdc,
    onStep: (s) => console.log(`  ${s.name} on ${s.chain}`),
  });

  const after = await new ArcEoaSettlementProvider().balanceUnits();
  console.log(`\nDrew $${result.amountUsdc} USDC${result.sources.length ? ` from ${result.sources.join(", ")}` : ""}.`);
  console.log(`  spendable on Arc: $${unitsToUsdc(after.toString()).toFixed(6)} USDC`);
  console.log("\nNo signer on Arc was needed: Circle's Forwarder submitted the mint.");
}

await main();
