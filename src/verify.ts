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

import { type ImpactSnapshot } from "meter402";
import { ARC_TESTNET_USDC, USDC_UNIT, unitsToUsdc } from "./arc";
import { GENESIS_BLOCK, agentAddress, headBlock, hexCall, rpcUrl, scanSettlements, settlementsToProvider } from "./chain";
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

  console.log("Settlements");
  console.log(`  agent:             ${agentAddress}`);
  console.log(`  token:             ${ARC_TESTNET_USDC} (USDC on Arc)`);
  console.log(`  blocks to scan:    ${fromBlock} to ${head}`);

  /**
   * Arc caps a log query at 10,000 blocks and throttles the calls on top of that,
   * so the full history is many sequential windows and takes a couple of minutes.
   * Say so, and show progress: a command that prints nothing for two minutes reads
   * as hung, whether the reader is a person or an agent.
   */
  const scan = await scanSettlements({
    fromBlock,
    toBlock: head,
    onWindow: (done, total) => {
      // Plain lines rather than a redrawn one: this output gets piped and read
      // as often as it gets watched, and a carriage return turns a log into soup.
      if (done === total || done % 10 === 0) console.log(`  scanning:          window ${done} of ${total}`);
    },
  });
  const totals = scan.totals;
  const paid = settlementsToProvider(totals.perProvider);

  if (scan.missed.length) {
    console.log(`  incomplete:        ${scan.missed.length} of ${scan.windows} windows could not be read`);
    for (const m of scan.missed.slice(0, 3)) {
      console.log(`                     blocks ${m.fromBlock}-${m.toBlock}: ${m.reason}`);
    }
    console.log("                     Everything below is therefore a floor, not the total.");
  }

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

  /**
   * Held against the provider-scoped total, not the raw outflow from the agent.
   * meter402's own `verifyAgainst` counts every transfer to a non-agent, which
   * includes the deposit that funded the Gateway balance, so checking against it
   * would pass a feed claiming up to $2 more than it settled. The stricter
   * comparison is the one worth publishing, and it reuses the scan already done
   * rather than reading the whole history a second time.
   */
  const claimedSettlements = claimed.totals?.settlements ?? 0;
  const claimedPaid = BigInt(claimed.totals?.totalPaid ?? "0");
  const chainPaid = BigInt(paid.totalUnits);
  const verified = !scan.missed.length && paid.settlements >= claimedSettlements && chainPaid >= claimedPaid;

  console.log("\nClaim check");
  console.log(`  feed claims:       ${claimedSettlements} settlements, ${usd(claimedPaid)}`);
  console.log(`  chain shows:       ${paid.settlements} settlements, ${usd(chainPaid)} to the provider`);
  console.log(
    `  verdict:           ${verified ? "PASS" : "FAIL"} - ${
      scan.missed.length
        ? "the scan was incomplete, so the chain figure is a floor and cannot settle the claim"
        : verified
          ? "the chain shows at least what the feed claims"
          : "the feed claims more than the chain shows"
    }`,
  );

  if (!verified) {
    process.exitCode = 1;
    return;
  }

  console.log(`\nEvery figure above came from ${rpcUrl}, not from Spigot.`);
  console.log(`One USDC is ${USDC_UNIT} smallest units; amounts are shown in whole USDC.`);
}

await main();
