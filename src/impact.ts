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
import {
  BLOCKS_PER_CHUNK,
  agentAddress,
  headBlock,
  providerAddress,
  resolveFromBlock,
  scanSettlements,
  settlementsToProvider,
} from "./chain";
import { GATEWAY_CHAIN } from "./nano";
import { withRetry } from "./retry";

/** One contiguous block range the feed actually read. */
export interface WindowRange {
  fromBlock: number;
  toBlock: number;
}

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
  /** Exactly which block ranges were read, so the bound is visible rather than implied. */
  scannedWindows: WindowRange[];
  /** Arc's head at the time of the request. */
  headBlock: number;
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
/**
 * Arc caps a log query at 10,000 blocks and produces about 130,000 a day, so no
 * request-time scan can cover the whole chain. The window has to be bounded, and
 * *which* bound is chosen decides whether this feed says anything true.
 *
 * Sliding the window back from the head was the obvious choice and it was wrong.
 * The direct rail settled between blocks 54,141,834 and 54,273,335 and has not
 * settled since, so a window anchored to the head walked off the end of the
 * history and the feed began publishing zero on-chain settlements while sixteen
 * real ones sat on the chain. A feed that under-reports to nothing is no more
 * honest than one that over-reports.
 *
 * So the window is anchored where the settlements are: forward from the first
 * one, far enough to cover the whole run with room to spare. It is a fixed cost
 * that does not grow with the chain, and `npm run verify` still scans genesis to
 * head with no bound at all.
 */
/** Blocks forward from the first settlement: covers the direct rail's own history. */
const HISTORY_CHUNKS = 16;
/** Blocks back from the head: covers anything the hosted console has just settled. */
const TAIL_CHUNKS = 6;
const SCAN_BUDGET_MS = 45_000;
/** A settled block is settled. Re-deriving finalised history every request is waste. */
const HISTORY_CACHE_MS = 60 * 60 * 1000;

let historyCache: { at: number; perProvider: Impact["perProvider"]; window: WindowRange } | null = null;

/**
 * Two bounded windows, not one.
 *
 * Anchoring only at the head walked off the end of the history and published zero
 * while sixteen settlements sat on the chain. Anchoring only at genesis has the
 * opposite failure: the hosted console settles live on every judge's click, and
 * those land at the head, outside a fixed historical window. Neither anchor alone
 * is honest, so the feed reads both ends and names the middle it did not read.
 *
 * Under-reporting is the safe direction here, and deliberately so: meter402's
 * invariant is that a feed may never claim more than the chain shows, so a gap
 * costs credit for real settlements but can never manufacture a fake one.
 */
async function fromArc(
  head: number,
): Promise<{ result: ImpactSource; perProvider: Impact["perProvider"]; windows: WindowRange[] }> {
  const genesis = resolveFromBlock({ toBlock: head });
  const historyTo = Math.min(head, genesis + HISTORY_CHUNKS * BLOCKS_PER_CHUNK - 1);
  const tailFrom = Math.max(genesis, head - TAIL_CHUNKS * BLOCKS_PER_CHUNK + 1);

  // When the chain is young enough that the two windows touch, it is one scan.
  const ranges: WindowRange[] =
    tailFrom <= historyTo + 1
      ? [{ fromBlock: genesis, toBlock: head }]
      : [
          { fromBlock: genesis, toBlock: historyTo },
          { fromBlock: tailFrom, toBlock: head },
        ];

  const started = Date.now();
  const merged: Impact["perProvider"] = {};
  const covered: WindowRange[] = [];
  let missed = 0;

  const absorb = (perProvider: Impact["perProvider"], window: WindowRange) => {
    for (const [label, row] of Object.entries(perProvider)) {
      const existing = merged[label] ?? { count: 0, total: "0" };
      merged[label] = {
        count: existing.count + row.count,
        total: (BigInt(existing.total) + BigInt(row.total)).toString(),
      };
    }
    covered.push(window);
  };

  // Newest first. The tail is the part that changes, so it gets the budget it
  // needs before the history is allowed to spend any: a scan that runs out of
  // time part way through the tail would drop the settlements a judge just made.
  for (const range of [...ranges].reverse()) {
    const isHistory = range.fromBlock === genesis;

    // Finalised blocks cannot change their mind, so a complete historical scan is
    // worth keeping for the life of the instance. Nothing is stored that is not a
    // derivation of the chain, and npm run verify re-derives it from scratch.
    if (isHistory && ranges.length > 1 && historyCache && Date.now() - historyCache.at < HISTORY_CACHE_MS) {
      absorb(historyCache.perProvider, historyCache.window);
      continue;
    }

    const scan = await scanSettlements({
      ...range,
      budgetMs: Math.max(8_000, SCAN_BUDGET_MS - (Date.now() - started)),
    });
    absorb(scan.totals.perProvider, { fromBlock: scan.fromBlock, toBlock: scan.toBlock });
    missed += scan.missed.length;

    if (isHistory && ranges.length > 1 && !scan.missed.length) {
      historyCache = {
        at: Date.now(),
        perProvider: scan.totals.perProvider,
        window: { fromBlock: scan.fromBlock, toBlock: scan.toBlock },
      };
    }
  }

  covered.sort((a, b) => a.fromBlock - b.fromBlock);

  const paid = settlementsToProvider(merged);
  const funding = paid.otherOutflows.reduce((n, o) => n + o.count, 0);
  const windowText = covered.map((w) => `${w.fromBlock} to ${w.toBlock}`).join(" and ");

  return {
    result: {
      settlements: paid.settlements,
      totalUnits: paid.totalUnits,
      totalUsd: unitsToUsdc(paid.totalUnits),
      source: "Arc USDC transfer log",
      note:
        `Transfers that reached the provider, re-derived at every request from blocks ${windowText}. ` +
        `Arc caps a log query at 10,000 blocks and produces about 130,000 a day, so the scan is bounded: ` +
        `it reads the window the direct rail settled in and the window the hosted console is settling in now. ` +
        `Anything between the two is not counted here, which makes this a floor; ` +
        `npm run verify scans the whole chain from block ${genesis} to ${head} with no bound at all.` +
        (missed ? ` ${missed} window(s) could not be read on this request.` : "") +
        (funding
          ? ` ${funding} further transfer(s) left the agent to fund its Circle Gateway balance; those are movement, not revenue, and are excluded.`
          : ""),
    },
    perProvider: merged,
    windows: covered,
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

  /**
   * Page through rather than reading the first hundred and calling it the total.
   * A single page would silently under-report the moment the agent passes that
   * many settlements, and a figure that quietly stops growing is worse than one
   * that is obviously missing.
   */
  const MAX_PAGES = 10;
  let total = 0n;
  let count = 0;
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await withRetry(
      () => gateway.searchTransfers({ from: agentAddress as `0x${string}`, pageSize: 100, pageAfter: cursor }),
      { label: "searchTransfers" },
    );

    for (const transfer of res.transfers ?? []) {
      if (transfer.toAddress?.toLowerCase() !== providerAddress.toLowerCase()) continue;
      total += BigInt(transfer.amount ?? "0");
      count += 1;
    }

    cursor = res.pagination?.pageAfter;
    if (!cursor || !res.transfers?.length) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return {
    settlements: count,
    totalUnits: total.toString(),
    totalUsd: unitsToUsdc(total.toString()),
    source: "Circle Gateway transfer API",
    note:
      "Signed off-chain and batched by Circle, so these do not appear as individual Arc transactions." +
      (truncated ? " More pages exist than were read; this is a floor, not the total." : ""),
  };
}

/** Build the public record. Failures are named, never rounded to zero silently. */
export async function buildImpact(): Promise<Impact> {
  const unavailable: string[] = [];
  const toBlock = await headBlock();

  let onChain = empty("Arc USDC transfer log", "Could not be read.");
  let perProvider: Impact["perProvider"] = {};
  let scannedWindows: WindowRange[] = [];
  try {
    const arc = await fromArc(toBlock);
    onChain = arc.result;
    perProvider = arc.perProvider;
    scannedWindows = arc.windows;
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
    scannedWindows,
    headBlock: toBlock,
    builtAt: new Date().toISOString(),
    unavailable,
  };
}
