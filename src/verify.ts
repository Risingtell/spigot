/**
 * Independent verification. Do not trust Spigot's numbers - re-derive them.
 *
 *   npm run verify
 *
 * Two things are checked here, and both read straight off Arc rather than out of
 * anything Spigot controls:
 *
 *   1. The fee market. Spigot's central claim is that per-second settlement is
 *      economical on Arc because gas is USDC and the fee is small. That is a
 *      measurement, not an opinion, so the command starts by taking it live and
 *      showing the settlement cadence it implies.
 *
 *   2. The settlements. Given the agent's Arc address, every USDC transfer it has
 *      made to a provider is summed from the token's `Transfer` logs, using
 *      meter402's chain verifier. If a claimed impact feed is supplied, the
 *      chain totals are held against it - the feed passes only if the chain shows
 *      at least what it claims.
 *
 * Runs with no keys and no wallet. Step 1 needs nothing at all; step 2 needs only
 * a public address, which anyone can paste into the Arc explorer to confirm.
 */

import { verifyAgainst, type ImpactSnapshot } from "meter402";
import { ARC_TESTNET_USDC, USDC_UNIT, unitsToUsdc } from "./arc";
import { GENESIS_BLOCK, agentAddress, arcVerifier, headBlock, hexCall, providerAddress, rpcUrl, settlementsToProvider } from "./chain";
import {
  economicSettlementSeconds,
  fetchSettlementCost,
  minEconomicSettlementUnits,
  overheadRatio,
} from "./arc-gas";

/** The reference stream price used to express the cadence in seconds. */
const REFERENCE_RATE_PER_SECOND = "1000"; // $0.001/sec
const MAX_OVERHEAD_RATIO = 0.05;

const impactUrl = process.env.SPIGOT_IMPACT_URL;

const usd = (units: string | bigint) => `$${unitsToUsdc(units.toString()).toFixed(6)}`;

async function main(): Promise<void> {
  console.log("Spigot verification - everything below is re-derived from Arc.\n");

  // -----------------------------------------------------------------------
  // 1. The fee market, measured live
  // -----------------------------------------------------------------------

  const chainId = Number(BigInt(await hexCall("eth_chainId")));
  const head = await headBlock();
  const cost = await fetchSettlementCost({ rpcUrl });
  const minSettle = minEconomicSettlementUnits(cost.costUnits, MAX_OVERHEAD_RATIO);
  const seconds = economicSettlementSeconds(minSettle, REFERENCE_RATE_PER_SECOND);

  console.log("Fee market");
  console.log(`  rpc:               ${rpcUrl}`);
  console.log(`  chain id:          ${chainId}${chainId === 5042002 ? " (Arc Testnet)" : ""}`);
  console.log(`  block height:      ${head}`);
  console.log(`  gas price:         ${cost.gasPriceGwei.toFixed(4)} gwei  (${cost.source})`);
  console.log(`  one settlement:    ${usd(cost.costUnits)} at ${cost.gasLimit} gas`);
  console.log(`  economical floor:  ${usd(minSettle)} to keep the chain fee under ${(MAX_OVERHEAD_RATIO * 100).toFixed(0)}%`);
  console.log(`  cadence:           settle about every ${seconds.toFixed(0)}s on a $0.001/sec stream\n`);

  if (cost.source === "fallback") {
    console.log("  Note: the live gas price could not be read, so the documented floor was used.\n");
  }

  // -----------------------------------------------------------------------
  // 2. The settlements, re-derived from the token ledger
  // -----------------------------------------------------------------------

  const fromBlock = process.env.SPIGOT_FROM_BLOCK ? Number(process.env.SPIGOT_FROM_BLOCK) : GENESIS_BLOCK;
  const verifier = arcVerifier({ toBlock: head, fromBlock });

  console.log("Settlements");
  console.log(`  agent:             ${agentAddress}`);
  console.log(`  token:             ${ARC_TESTNET_USDC} (USDC on Arc)`);
  console.log(`  blocks scanned:    ${fromBlock} to ${head}`);

  const totals = await verifier.reDeriveTotals();
  const paid = settlementsToProvider(totals.perProvider);

  console.log(`  settlements:       ${paid.settlements}`);
  console.log(`  total settled:     ${usd(paid.totalUnits)}`);
  for (const other of paid.otherOutflows) {
    // Funding the Gateway balance also leaves the agent. It is movement, not
    // revenue, and counting it would inflate the claim.
    console.log(`    excluded, not a settlement: ${other.count} transfer(s) to ${other.label}, ${usd(other.total)}`);
  }

  if (paid.settlements > 0) {
    const perSettlement = BigInt(paid.totalUnits) / BigInt(paid.settlements);
    const ratio = overheadRatio(cost.costUnits, perSettlement.toString());
    console.log(`  average size:      ${usd(perSettlement)}`);
    console.log(`  chain fee share:   ${(ratio * 100).toFixed(2)}% of each settlement`);
    if (ratio > MAX_OVERHEAD_RATIO) {
      console.log("  The settled amounts are small against the current fee. Widen the cadence.");
    }
  }

  // -----------------------------------------------------------------------
  // 3. Hold a claimed feed against the chain, if one was given
  // -----------------------------------------------------------------------

  if (!impactUrl) {
    console.log("\nSet SPIGOT_IMPACT_URL to a published impact feed to hold its claims against these totals.");
    return;
  }

  const res = await fetch(impactUrl);
  if (!res.ok) {
    console.error(`\nCould not read the claimed feed at ${impactUrl} (${res.status}).`);
    process.exitCode = 1;
    return;
  }

  const claimed = (await res.json()) as ImpactSnapshot;
  const report = await verifyAgainst(verifier, claimed);

  console.log("\nClaim check");
  console.log(`  feed claims:       ${report.claimed.settlements} settlements, ${usd(report.claimed.totalPaid)}`);
  console.log(`  chain shows:       ${report.chain.settlements} settlements, ${usd(report.chain.totalPaid)}`);
  console.log(`  verdict:           ${report.verified ? "PASS" : "FAIL"} - ${report.note}`);

  if (!report.verified) {
    process.exitCode = 1;
    return;
  }

  console.log(`\nEvery figure above came from ${rpcUrl}, not from Spigot.`);
  console.log(`One USDC is ${USDC_UNIT} smallest units; amounts are shown in whole USDC.`);
}

await main();
