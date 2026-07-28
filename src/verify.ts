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

/**
 * Spigot's own agent and provider on Arc, so `npm run verify` proves something
 * real from a cold clone with nothing configured. Both are public addresses; point
 * the script at your own by setting SPIGOT_AGENT_ADDRESS.
 */
const SPIGOT_AGENT = "0x201EE872d4b1a3c06589032F682004a09ddB6aBA";
const SPIGOT_PROVIDER = "0x9379Ec21C3c199C83145dcD377955E8E04BBC200";

/**
 * The block Spigot's first live settlement landed in. The scan is anchored here
 * rather than sliding back from the head, so the window never drifts past the
 * history it is meant to prove. Override with SPIGOT_FROM_BLOCK for another agent.
 */
const GENESIS_BLOCK = 54_141_800;

/** Arc's public RPC caps a single eth_getLogs range, and rate-limits bursts. */
const CHUNK_SIZE = 10_000;
const PACE_MS = 120;

/** The reference stream price used to express the cadence in seconds. */
const REFERENCE_RATE_PER_SECOND = "1000"; // $0.001/sec
const MAX_OVERHEAD_RATIO = 0.05;

const rpcUrl = process.env.SPIGOT_RPC_URL ?? ARC_TESTNET_RPC;
const agentAddress = process.env.SPIGOT_AGENT_ADDRESS ?? SPIGOT_AGENT;
const providerAddress = process.env.SPIGOT_PROVIDER_ADDRESS ?? SPIGOT_PROVIDER;
const impactUrl = process.env.SPIGOT_IMPACT_URL;

const usd = (units: string | bigint) => `$${unitsToUsdc(units.toString()).toFixed(6)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A JSON-RPC transport that survives a public endpoint. Scanning a log range takes
 * many sequential calls and Arc's public RPC rate-limits a burst of them with a
 * 429, which killed the first live run of this script. Back off and retry rather
 * than failing the whole verification on one throttled request.
 */
async function call(method: string, params: unknown[]): Promise<unknown> {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }

    // 429 is throttling and 5xx is transient; both are worth waiting out.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** (attempt - 1);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Arc RPC ${method} returned ${res.status}`);

    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? `Arc RPC ${method} failed`);
    return body.result ?? null;
  }
}

/** Paced transport handed to meter402's verifier, so its chunked scan behaves. */
const pacedRpc = async (method: string, params: unknown[]): Promise<unknown> => {
  const result = await call(method, params);
  if (method === "eth_getLogs") await sleep(PACE_MS);
  return result;
};

async function rpc(method: string, params: unknown[]): Promise<string> {
  return ((await call(method, params)) as string) ?? "0x0";
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

  const fromBlock = process.env.SPIGOT_FROM_BLOCK ? Number(process.env.SPIGOT_FROM_BLOCK) : GENESIS_BLOCK;

  const verifier = createEvmVerifier({
    network: ARC_TESTNET_CAIP2,
    token: ARC_TESTNET_USDC,
    agents: [agentAddress],
    providerNames: providerAddress ? { [providerAddress.toLowerCase()]: "provider treasury" } : undefined,
    rpc: pacedRpc,
    chunkSize: CHUNK_SIZE,
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
