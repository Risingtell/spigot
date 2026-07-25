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

import { createEvmVerifier, verifyAgainst, type ImpactSnapshot } from "meter402";
import { ARC_TESTNET_CAIP2, ARC_TESTNET_RPC, ARC_TESTNET_USDC, USDC_UNIT, unitsToUsdc } from "./arc";
import {
  economicSettlementSeconds,
  fetchSettlementCost,
  minEconomicSettlementUnits,
  overheadRatio,
} from "./arc-gas";

/** Blocks to scan back from the chain head when no explicit window is given. */
const DEFAULT_LOOKBACK_BLOCKS = 200_000;
/** The reference stream price used to express the cadence in seconds. */
const REFERENCE_RATE_PER_SECOND = "1000"; // $0.001/sec
const MAX_OVERHEAD_RATIO = 0.05;

const rpcUrl = process.env.SPIGOT_RPC_URL ?? ARC_TESTNET_RPC;
const agentAddress = process.env.SPIGOT_AGENT_ADDRESS;
const providerAddress = process.env.SPIGOT_PROVIDER_ADDRESS;
const impactUrl = process.env.SPIGOT_IMPACT_URL;

const usd = (units: string | bigint) => `$${unitsToUsdc(units.toString()).toFixed(6)}`;

async function rpc(method: string, params: unknown[]): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Arc RPC ${method} returned ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `Arc RPC ${method} failed`);
  return body.result ?? "0x0";
}

async function main(): Promise<void> {
  console.log("Spigot verification - everything below is re-derived from Arc.\n");

  // -----------------------------------------------------------------------
  // 1. The fee market, measured live
  // -----------------------------------------------------------------------

  const chainId = Number(BigInt(await rpc("eth_chainId", [])));
  const head = Number(BigInt(await rpc("eth_blockNumber", [])));
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

  if (!agentAddress) {
    console.log("Settlements");
    console.log("  No agent address supplied, so there is nothing on-chain to re-derive yet.");
    console.log("  Set SPIGOT_AGENT_ADDRESS to the agent's Arc address and run this again;");
    console.log("  every USDC transfer it made to a provider will be summed from Arc's logs.");
    console.log("\n  Spigot claims no settled totals it cannot show here.");
    return;
  }

  const fromBlock = process.env.SPIGOT_FROM_BLOCK
    ? Number(process.env.SPIGOT_FROM_BLOCK)
    : Math.max(0, head - DEFAULT_LOOKBACK_BLOCKS);

  const verifier = createEvmVerifier({
    network: ARC_TESTNET_CAIP2,
    token: ARC_TESTNET_USDC,
    agents: [agentAddress],
    providerNames: providerAddress ? { [providerAddress.toLowerCase()]: "provider treasury" } : undefined,
    rpcUrl,
    fromBlock,
    toBlock: head,
  });

  console.log("Settlements");
  console.log(`  agent:             ${agentAddress}`);
  console.log(`  token:             ${ARC_TESTNET_USDC} (USDC on Arc)`);
  console.log(`  blocks scanned:    ${fromBlock} to ${head}`);

  const totals = await verifier.reDeriveTotals();

  console.log(`  settlements:       ${totals.settlements}`);
  console.log(`  total settled:     ${usd(totals.totalPaid)}`);
  for (const [name, row] of Object.entries(totals.perProvider)) {
    console.log(`    ${name}: ${row.count} transfers, ${usd(row.total)}`);
  }

  if (totals.settlements > 0) {
    const perSettlement = BigInt(totals.totalPaid) / BigInt(totals.settlements);
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
