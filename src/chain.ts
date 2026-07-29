/**
 * The shared read layer for Arc.
 *
 * Both the verifier and the public impact feed answer the same question, "what
 * did this agent actually settle", and neither of them should answer it from
 * anything Spigot stores. They read the token ledger. This module is the one
 * place that knows how to do that against a public endpoint that throttles.
 */

import { custom } from "viem";
import { createEvmVerifier, type VerifierAdapter } from "meter402";
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

/** Arc caps a single eth_getLogs range and rate-limits bursts of them. */
const CHUNK_SIZE = 10_000;
const PACE_MS = 120;

export const rpcUrl = process.env.SPIGOT_RPC_URL ?? ARC_TESTNET_RPC;
export const agentAddress = process.env.SPIGOT_AGENT_ADDRESS ?? SPIGOT_AGENT;
export const providerAddress = process.env.SPIGOT_PROVIDER_ADDRESS ?? SPIGOT_PROVIDER;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A JSON-RPC call that survives a public endpoint. Scanning a log range takes many
 * sequential calls and Arc answers a burst with a 429, which killed the first live
 * verification run. Back off and retry rather than failing the whole read.
 */
export async function call(method: string, params: unknown[]): Promise<unknown> {
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
export function arcVerifier(opts: { agents?: string[]; fromBlock?: number; toBlock: number }): VerifierAdapter {
  return createEvmVerifier({
    network: ARC_TESTNET_CAIP2,
    token: ARC_TESTNET_USDC,
    agents: opts.agents ?? [agentAddress],
    providerNames: { [providerAddress.toLowerCase()]: "provider treasury" },
    rpc: pacedRpc,
    chunkSize: CHUNK_SIZE,
    fromBlock: opts.fromBlock ?? (process.env.SPIGOT_FROM_BLOCK ? Number(process.env.SPIGOT_FROM_BLOCK) : GENESIS_BLOCK),
    toBlock: opts.toBlock,
  });
}
