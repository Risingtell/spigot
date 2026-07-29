/**
 * The public record of what Spigot has settled.
 *
 * Most projects publish a number from their own database and ask you to believe
 * it. This one holds nothing. Every figure below is fetched, on request, from a
 * source outside Spigot's control:
 *
 *   - direct on-chain settlements come from Arc's USDC transfer log
 *   - gas-free settlements come from Circle's own Gateway transfer API
 *
 * There is no table to drift, no counter to inflate, and nothing to reconcile
 * after the fact. If Spigot claims it, the claim is a query against somebody
 * else's ledger, and `npm run verify` re-runs the on-chain half independently.
 */

import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ARC_TESTNET_CAIP2, unitsToUsdc } from "./arc";
import { agentAddress, arcVerifier, headBlock, providerAddress, resolveFromBlock, settlementsToProvider } from "./chain";
import { GATEWAY_CHAIN } from "./nano";
import { withRetry } from "./retry";

export interface ImpactSource {
  settlements: number;
  totalUnits: string;
  totalUsd: number;
  source: string;
  note: string;
}

export interface Impact {
  network: string;
  agent: string;
  provider: string;
  onChain: ImpactSource;
  gateway: ImpactSource;
  combined: { settlements: number; totalUnits: string; totalUsd: number };
  /**
   * The claim in meter402's snapshot shape, so `npm run verify` can hold this feed
   * against the chain directly.
   *
   * It deliberately carries the on-chain figure alone, not the combined one. The
   * chain can only back what settled on it; the gas-free half is evidenced by
   * Circle's API instead. Claiming the combined total here would make the feed
   * fail its own verification, and rightly so.
   */
  totals: {
    settlements: number;
    totalPaid: string;
    asset: string;
    activeSessions: number;
    uniqueAgents: number;
    uniqueProviders: number;
    secondsStreamed: number;
  };
  perProvider: Record<string, { count: number; total: string }>;
  scannedFromBlock: number;
  scannedToBlock: number;
  builtAt: string;
  /** Anything that could not be read, named rather than silently zeroed. */
  unavailable: string[];
}

const empty = (source: string, note: string): ImpactSource => ({
  settlements: 0,
  totalUnits: "0",
  totalUsd: 0,
  source,
  note,
});

/**
 * Direct settlements, summed from Arc's token ledger. A settlement is a USDC
 * transfer from the agent to a non-agent, which excludes funding the wallet and
 * excludes the Gateway deposit.
 */
const MAX_CHUNKS = 6; // about 54,000 blocks, comfortably inside a request timeout

async function fromArc(
  toBlock: number,
): Promise<{ result: ImpactSource; perProvider: Impact["perProvider"]; fromBlock: number }> {
  const fromBlock = resolveFromBlock({ toBlock, maxChunks: MAX_CHUNKS });
  const totals = await arcVerifier({ toBlock, fromBlock }).reDeriveTotals();
  const paid = settlementsToProvider(totals.perProvider);
  const funding = paid.otherOutflows.reduce((n, o) => n + o.count, 0);

  return {
    result: {
      settlements: paid.settlements,
      totalUnits: paid.totalUnits,
      totalUsd: unitsToUsdc(paid.totalUnits),
      source: "Arc USDC transfer log",
      note:
        `Transfers that reached the provider, over blocks ${fromBlock} to ${toBlock}. ` +
        "Arc caps a log query at 10,000 blocks and produces about 130,000 a day, so this feed reads a recent window; " +
        "npm run verify scans the full history from the first settlement." +
        (funding
          ? ` ${funding} further transfer(s) left the agent to fund its Circle Gateway balance; those are movement, not revenue, and are excluded.`
          : ""),
    },
    perProvider: totals.perProvider,
    fromBlock,
  };
}

/**
 * Gas-free settlements, read back from Circle. These never appear individually
 * on-chain, because Gateway batches them, so Circle's own API is the ledger.
 */
async function fromGateway(): Promise<ImpactSource> {
  const key = process.env.SPIGOT_ARC_KEY;
  if (!key) {
    return empty("Circle Gateway transfers", "No agent key configured on this deployment, so Gateway was not queried.");
  }

  const privateKey = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
  const gateway = new GatewayClient({ chain: GATEWAY_CHAIN, privateKey });

  const page = await withRetry(
    () => gateway.searchTransfers({ from: agentAddress as `0x${string}`, pageSize: 100 }),
    { label: "searchTransfers" },
  );

  let total = 0n;
  let count = 0;
  for (const transfer of page.transfers ?? []) {
    if (transfer.toAddress?.toLowerCase() !== providerAddress.toLowerCase()) continue;
    total += BigInt(transfer.amount ?? "0");
    count += 1;
  }

  return {
    settlements: count,
    totalUnits: total.toString(),
    totalUsd: unitsToUsdc(total.toString()),
    source: "Circle Gateway transfer API",
    note: "Signed off-chain and batched by Circle, so these do not appear as individual Arc transactions.",
  };
}

/** Build the public record. Failures are named, never rounded to zero silently. */
export async function buildImpact(): Promise<Impact> {
  const unavailable: string[] = [];
  const toBlock = await headBlock();

  let onChain = empty("Arc USDC transfer log", "Could not be read.");
  let perProvider: Impact["perProvider"] = {};
  let scannedFromBlock = toBlock;
  try {
    const arc = await fromArc(toBlock);
    onChain = arc.result;
    perProvider = arc.perProvider;
    scannedFromBlock = arc.fromBlock;
  } catch (err) {
    unavailable.push(`Arc log scan: ${(err as Error).message}`);
  }

  let gateway = empty("Circle Gateway transfer API", "Could not be read.");
  try {
    gateway = await fromGateway();
  } catch (err) {
    unavailable.push(`Gateway transfers: ${(err as Error).message}`);
  }

  const combinedUnits = BigInt(onChain.totalUnits) + BigInt(gateway.totalUnits);

  return {
    network: ARC_TESTNET_CAIP2,
    agent: agentAddress,
    provider: providerAddress,
    onChain,
    gateway,
    combined: {
      settlements: onChain.settlements + gateway.settlements,
      totalUnits: combinedUnits.toString(),
      totalUsd: unitsToUsdc(combinedUnits.toString()),
    },
    totals: {
      settlements: onChain.settlements,
      totalPaid: onChain.totalUnits,
      asset: "USDC",
      activeSessions: 0,
      uniqueAgents: 1,
      uniqueProviders: Object.keys(perProvider).length,
      secondsStreamed: 0,
    },
    perProvider,
    scannedFromBlock,
    scannedToBlock: toBlock,
    builtAt: new Date().toISOString(),
    unavailable,
  };
}
