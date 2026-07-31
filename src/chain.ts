/**
 * The shared read layer for Arc.
 *
 * Both the verifier and the public impact feed answer the same question, "what
 * did this agent actually settle", and neither of them should answer it from
 * anything Spigot stores. They read the token ledger. This module is the one
 * place that knows how to do that against a public endpoint that throttles.
 */

import { custom } from "viem";
import { createEvmVerifier, type OnChainTotals, type VerifierAdapter } from "meter402";
import { ARC_TESTNET_CAIP2, ARC_TESTNET_RPC, ARC_TESTNET_USDC } from "./arc";

/**
 * Spigot's own agent and provider on Arc, so the verifier and the feed both prove
 * something real with nothing configured. Public addresses; override with
 * SPIGOT_AGENT_ADDRESS / SPIGOT_PROVIDER_ADDRESS.
 */
export const SPIGOT_AGENT = "0x201EE872d4b1a3c06589032F682004a09ddB6aBA";
export const SPIGOT_PROVIDER = "0x9379Ec21C3c199C83145dcD377955E8E04BBC200";

/**
 * The block Spigot's first live settlement landed in. Anchoring here rather than
 * sliding back from the head keeps the window from drifting past the history it
 * is meant to prove.
 */
export const GENESIS_BLOCK = 54_141_800;

/**
 * Arc rejects any eth_getLogs range wider than 10,000 blocks outright, with
 * "eth_getLogs is limited to a 10,000 range". Stay just under it.
 */
const CHUNK_SIZE = 9_000;
const PACE_MS = 120;

/**
 * Arc produces roughly 130,000 blocks a day, so a scan anchored at the first
 * settlement grows by about fourteen chunks daily and will eventually outlast any
 * request timeout. The CLI can afford the full history; a serverless handler
 * cannot, so callers bound it and report the window they actually covered rather
 * than implying they read everything.
 */
export const BLOCKS_PER_CHUNK = CHUNK_SIZE;

export const rpcUrl = process.env.SPIGOT_RPC_URL ?? ARC_TESTNET_RPC;
export const agentAddress = process.env.SPIGOT_AGENT_ADDRESS ?? SPIGOT_AGENT;
export const providerAddress = process.env.SPIGOT_PROVIDER_ADDRESS ?? SPIGOT_PROVIDER;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A JSON-RPC call that survives a public endpoint. Scanning a log range takes many
 * sequential calls and Arc answers a burst with a 429, which killed the first live
 * verification run. Back off and retry rather than failing the whole read.
 */
/**
 * Arc throttles `eth_getLogs` by call count, not by response size, and it bites
 * hard: measured against the public endpoint, only 8 to 14 of 25 sequential
 * scans succeed, and slowing the pace from 120ms to 600ms does not help at all.
 * Since a full history scan is now 59 windows and grows by about fourteen a day,
 * the retry budget is what decides whether `npm run verify` finishes or dies
 * halfway through. Six attempts over twelve seconds was not enough and the
 * command crashed with a stack trace. This budget waits the limiter out.
 */
const MAX_ATTEMPTS = 9;
const MAX_BACKOFF_MS = 8_000;

const backoff = (attempt: number) => Math.min(MAX_BACKOFF_MS, 400 * 2 ** (attempt - 1));

export async function call(method: string, params: unknown[]): Promise<unknown> {
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
      await sleep(backoff(attempt));
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Arc RPC ${method} returned ${res.status}`);

    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? `Arc RPC ${method} failed`);
    return body.result ?? null;
  }
}

/** Paced transport for meter402's chunked log scan. */
export const pacedRpc = async (method: string, params: unknown[]): Promise<unknown> => {
  const result = await call(method, params);
  if (method === "eth_getLogs") await sleep(PACE_MS);
  return result;
};

export async function hexCall(method: string, params: unknown[] = []): Promise<string> {
  return ((await call(method, params)) as string) ?? "0x0";
}

export async function headBlock(): Promise<number> {
  return Number(BigInt(await hexCall("eth_blockNumber")));
}

/**
 * A viem transport that goes through the retrying, paced call above.
 *
 * viem's default HTTP transport talks straight to the endpoint, so anything built
 * on it inherits Arc's throttling. That bit the hosted console: polling
 * `eth_getTransactionReceipt` after a settlement tripped the limit, and the agent
 * closed the session mid-run with "settlement failed". Routing viem through the
 * same transport as everything else fixes it in one place, and works inside a
 * serverless function where a local proxy process is not an option.
 */
export function pacedTransport() {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      return call(method, (params as unknown[]) ?? []);
    },
  });
}

/** The label meter402 gives transfers that reached the configured provider. */
export const PROVIDER_LABEL = "provider treasury";

/**
 * Circle's Gateway wallet on Arc Testnet. The agent's deposit into Gateway lands
 * here and is the one outflow that is emphatically not revenue, so name it: an
 * excluded line reading "Circle Gateway deposit" says what happened, where
 * "provider 0x0077777d..." leaves a reader to work it out.
 */
export const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

/**
 * Settlements are transfers that reached the provider, and nothing else.
 *
 * meter402 defines a settlement as any transfer from an agent to a non-agent,
 * which is right in general and wrong here: funding the agent's Circle Gateway
 * balance is also a transfer out of the agent, to the Gateway wallet. Counting it
 * inflated the on-chain total from $0.46 to $2.46 and added a settlement that
 * never happened, which is precisely the overclaim this project exists to avoid.
 *
 * So the on-chain figure is scoped to the provider explicitly. Anything else the
 * agent sent is reported separately as movement, never as revenue.
 */
export function settlementsToProvider(perProvider: Record<string, { count: number; total: string }>): {
  settlements: number;
  totalUnits: string;
  otherOutflows: { label: string; count: number; total: string }[];
} {
  const paid = perProvider[PROVIDER_LABEL];
  const otherOutflows = Object.entries(perProvider)
    .filter(([label]) => label !== PROVIDER_LABEL)
    .map(([label, row]) => ({ label, count: row.count, total: row.total }));

  return {
    settlements: paid?.count ?? 0,
    totalUnits: paid?.total ?? "0",
    otherOutflows,
  };
}

/** A verifier over Arc's USDC ledger for one or more agent addresses. */
export function arcVerifier(opts: {
  agents?: string[];
  fromBlock?: number;
  toBlock: number;
  /** Cap the scan to this many chunks back from the head. Omit to scan from genesis. */
  maxChunks?: number;
}): VerifierAdapter {
  return createEvmVerifier({
    network: ARC_TESTNET_CAIP2,
    token: ARC_TESTNET_USDC,
    agents: opts.agents ?? [agentAddress],
    providerNames: {
      [providerAddress.toLowerCase()]: PROVIDER_LABEL,
      [GATEWAY_WALLET.toLowerCase()]: "Circle Gateway deposit",
    },
    rpc: pacedRpc,
    chunkSize: CHUNK_SIZE,
    fromBlock: resolveFromBlock(opts),
    toBlock: opts.toBlock,
  });
}

/** The first block a scan will actually read, honouring any chunk budget. */
export function resolveFromBlock(opts: { fromBlock?: number; toBlock: number; maxChunks?: number }): number {
  const anchored =
    opts.fromBlock ?? (process.env.SPIGOT_FROM_BLOCK ? Number(process.env.SPIGOT_FROM_BLOCK) : GENESIS_BLOCK);
  if (!opts.maxChunks) return anchored;
  const bounded = opts.toBlock - opts.maxChunks * CHUNK_SIZE;
  return Math.max(anchored, bounded);
}

/** A window the scan could not read, kept rather than quietly folded into a zero. */
export interface MissedWindow {
  fromBlock: number;
  toBlock: number;
  reason: string;
}

export interface ScanResult {
  totals: OnChainTotals;
  fromBlock: number;
  /** The last block actually read, which is not always the one asked for. */
  toBlock: number;
  missed: MissedWindow[];
  windows: number;
}

/**
 * Re-derive settlements one 9,000-block window at a time, and survive the parts
 * that fail.
 *
 * Handing the whole range to a single verifier meant one throttled window took
 * the entire scan down with it, which is what made `npm run verify` exit with a
 * stack trace on a fresh clone. Driving the windows here means a window that
 * cannot be read is named and skipped, the totals from every other window still
 * stand, and the caller can say plainly that the figure is a floor rather than
 * presenting a short count as if it were complete.
 *
 * `budgetMs` exists for the serverless caller, which has a wall clock the CLI
 * does not. When it runs out the scan stops early and reports how far it got.
 */
export async function scanSettlements(opts: {
  fromBlock: number;
  toBlock: number;
  agents?: string[];
  budgetMs?: number;
  onWindow?: (done: number, total: number) => void;
}): Promise<ScanResult> {
  const started = Date.now();
  const windows = Math.max(1, Math.ceil((opts.toBlock - opts.fromBlock + 1) / CHUNK_SIZE));
  const perProvider: Record<string, { count: number; total: string }> = {};
  const missed: MissedWindow[] = [];

  let settlements = 0;
  let totalPaid = 0n;
  let covered = opts.fromBlock - 1;
  let done = 0;

  for (let from = opts.fromBlock; from <= opts.toBlock; from += CHUNK_SIZE) {
    const to = Math.min(from + CHUNK_SIZE - 1, opts.toBlock);

    if (opts.budgetMs && Date.now() - started > opts.budgetMs) {
      missed.push({ fromBlock: from, toBlock: opts.toBlock, reason: "time budget for this request ran out" });
      break;
    }

    try {
      const totals = await arcVerifier({ agents: opts.agents, fromBlock: from, toBlock: to }).reDeriveTotals();
      settlements += totals.settlements;
      totalPaid += BigInt(totals.totalPaid);
      for (const [label, row] of Object.entries(totals.perProvider)) {
        const existing = perProvider[label] ?? { count: 0, total: "0" };
        perProvider[label] = {
          count: existing.count + row.count,
          total: (BigInt(existing.total) + BigInt(row.total)).toString(),
        };
      }
      covered = to;
    } catch (err) {
      missed.push({ fromBlock: from, toBlock: to, reason: (err as Error).message });
    }

    done += 1;
    opts.onWindow?.(done, windows);
    await sleep(PACE_MS);
  }

  return {
    totals: { network: ARC_TESTNET_CAIP2, settlements, totalPaid: totalPaid.toString(), perProvider },
    fromBlock: opts.fromBlock,
    toBlock: Math.max(covered, opts.fromBlock),
    missed,
    windows,
  };
}
