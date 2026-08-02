/**
 * The agent's treasury: one USDC balance, every chain.
 *
 * A streaming agent has a failure mode a per-request agent does not. It is
 * mid-stream, holding something it is actively paying for by the second, when the
 * chain it settles on runs dry. Waiting for a person to notice is exactly the
 * autonomy gap the Agentic Economy track is about.
 *
 * The obvious fix is a reserve on one named chain and a bridge to move it, which
 * is what this module used to be. It was the wrong shape twice over. It made the
 * agent do treasury management, picking a source chain and a moment; and it only
 * worked for an agent holding a Circle developer-controlled wallet, which the
 * agent that actually settles here does not have. So `npm run topup` could not
 * run at all against the configuration everything else uses.
 *
 * Circle's Unified Balance Kit removes the whole question. The agent deposits
 * USDC into Gateway on whatever chains it happens to hold funds on, and from then
 * on it has one balance rather than several. `spend()` picks the source chains
 * itself, destination chain first and Ethereum last, builds one burn intent per
 * source, batch-signs them over EIP-712, and mints on the destination.
 *
 * That matters to Spigot's argument specifically. Its claim is a buyer with a
 * budget it cannot breach. A budget spread over six chains is not one budget, it
 * is six, and the agent that has to reconcile them is doing bookkeeping rather
 * than deciding. One balance makes the policy mean what it says.
 *
 * It also needs no Circle organisation, no API key and no entity secret: the
 * kit authenticates through the adapter, so the same private key that settles on
 * Arc is the one that moves the reserve. And the mint uses the Forwarder, so the
 * agent still needs no signer on the chain it is being funded into.
 */

import { UnifiedBalanceKit } from "@circle-fin/unified-balance-kit";
import { ViemAdapter, createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, createWalletClient, http, type Chain, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, USDC_UNIT, unitsToUsdc, usdcToUnits } from "./arc";
import { pacedTransport } from "./chain";

/**
 * Chains the agent can hold its reserve on. Every one of these is a Gateway v1
 * chain, which is what makes them addable to a single balance.
 */
export type ReserveChain =
  | "Ethereum_Sepolia"
  | "Base_Sepolia"
  | "Avalanche_Fuji"
  | "Arbitrum_Sepolia"
  | "Optimism_Sepolia"
  | "Polygon_Amoy_Testnet"
  | "Unichain_Sepolia";

/** Where settlement happens, and so where a top-up has to land. */
export const SPEND_CHAIN = "Arc_Testnet" as const;

/**
 * Any Gateway chain the agent can deposit from, Arc included.
 *
 * Depositing on Arc is not a redundant round trip. Gateway balance on Arc is what
 * the gas-free rail spends, so this is how that rail is refilled, and it is the
 * one deposit the agent can always make: everywhere else the deposit is an
 * ordinary transaction that needs that chain's own gas token, while on Arc the
 * gas is the USDC being deposited.
 */
export type DepositChain = ReserveChain | typeof SPEND_CHAIN;

export interface TreasuryPolicy {
  /** Top up once the Arc balance falls below this, in USDC smallest units. */
  floorUnits: string;
  /** Bring the Arc balance back up to this, in USDC smallest units. */
  targetUnits: string;
  /**
   * Kept for the runner's own reporting. The agent no longer chooses a source
   * chain; auto-allocation does, across everything it holds.
   */
  reserveChain: ReserveChain;
}

export interface TopUpPlan {
  needed: boolean;
  balanceUnits: string;
  floorUnits: string;
  /** Whole USDC to draw, as the string the kit expects. Empty when not needed. */
  amountUsdc: string;
  reason: string;
}

/**
 * Decide whether to top up, and by how much. Pure and testable: no chain access,
 * so the same rule can be asserted in a test and read by a judge.
 */
export function planTopUp(balanceUnits: string, policy: TreasuryPolicy): TopUpPlan {
  const balance = BigInt(balanceUnits);
  const floor = BigInt(policy.floorUnits);
  const target = BigInt(policy.targetUnits);
  if (target <= floor) throw new Error("Treasury target must sit above the floor.");

  if (balance >= floor) {
    return {
      needed: false,
      balanceUnits,
      floorUnits: policy.floorUnits,
      amountUsdc: "",
      reason: `balance ${fmt(balance)} is above the ${fmt(floor)} floor`,
    };
  }

  const shortfall = target - balance;
  return {
    needed: true,
    balanceUnits,
    floorUnits: policy.floorUnits,
    amountUsdc: (Number(shortfall) / USDC_UNIT).toFixed(6),
    reason: `balance ${fmt(balance)} fell below the ${fmt(floor)} floor`,
  };
}

const fmt = (units: bigint) => `$${unitsToUsdc(units.toString()).toFixed(6)}`;

/** Convenience for policies written in whole USDC rather than smallest units. */
export function treasuryPolicy(opts: {
  floorUsdc: number;
  targetUsdc: number;
  reserveChain: ReserveChain;
}): TreasuryPolicy {
  return {
    floorUnits: usdcToUnits(opts.floorUsdc),
    targetUnits: usdcToUnits(opts.targetUsdc),
    reserveChain: opts.reserveChain,
  };
}

/**
 * The agent's adapter, with Arc's throttle designed around rather than hoped past.
 *
 * `createViemAdapterFromPrivateKey` is the zero-config factory and it builds
 * clients on viem's plain `http()` transport. That is fine on an ordinary chain
 * and wrong on Arc's public endpoint, which caps how many calls may be in flight
 * rather than how many are made. The kit fans out reads while it works out
 * balances, allowances and permit nonces, so a deposit fails on a funded wallet
 * and a healthy endpoint with "request limit reached", and no amount of retrying
 * helps: retries cannot fix a concurrency cap.
 *
 * So Arc's clients are built by hand on the same serialising transport the
 * settlement path uses, and every other chain keeps the default.
 */
function adapterFor(privateKey: string) {
  if (!privateKey) throw new Error("No agent key: the agent cannot move its own funds.");
  const key = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(key);

  const clientsFor = (chain: Chain) => {
    const onArc = chain.id === ARC_TESTNET_CHAIN_ID;
    return onArc ? pacedTransport() : http();
  };

  // The same capabilities the zero-config factory would have given, key-controlled
  // across every EVM chain. Only the transport is being changed here.
  const { capabilities } = createViemAdapterFromPrivateKey({ privateKey: key });
  if (!capabilities) throw new Error("The viem adapter reported no capabilities to carry over.");

  return new ViemAdapter(
    {
      getPublicClient: ({ chain }) => createPublicClient({ chain, transport: clientsFor(chain) }) as PublicClient,
      getWalletClient: ({ chain }) => createWalletClient({ account, chain, transport: clientsFor(chain) }),
    },
    capabilities,
  );
}

export interface ChainBalance {
  chain: string;
  /** Confirmed, spendable through Gateway, in USDC smallest units. */
  units: string;
  usd: number;
}

export interface UnifiedBalance {
  perChain: ChainBalance[];
  /** Everything the agent can spend, wherever it sits, in smallest units. */
  totalUnits: string;
  totalUsd: number;
}

/**
 * What the agent can spend, across every chain at once.
 *
 * This is the number the budget is really written against, and it is read from
 * Circle rather than from anything Spigot keeps. Chains holding nothing are
 * dropped so the answer stays about where the money is.
 */
export async function unifiedBalance(privateKey: string): Promise<UnifiedBalance> {
  const kit = new UnifiedBalanceKit();
  const result = await kit.getBalances({
    sources: { adapter: adapterFor(privateKey) },
    token: "USDC",
    // Without this the kit queries mainnet and every chain reads zero, which is
    // true and useless. Arc is testnet-only for now, so the whole agent is.
    networkType: "testnet",
  });

  const perChain: ChainBalance[] = [];
  let total = 0n;

  for (const account of result.breakdown ?? []) {
    for (const row of account.breakdown ?? []) {
      const units = BigInt(usdcToUnits(Number(row.confirmedBalance)));
      if (units <= 0n) continue;
      perChain.push({ chain: row.chain, units: units.toString(), usd: unitsToUsdc(units.toString()) });
      total += units;
    }
  }

  perChain.sort((a, b) => Number(BigInt(b.units) - BigInt(a.units)));
  return { perChain, totalUnits: total.toString(), totalUsd: unitsToUsdc(total.toString()) };
}

export interface TreasuryStep {
  /** The Gateway operation, e.g. deposit, spend. */
  name: string;
  /** The chain it touched, or "aggregate" for the cross-chain step. */
  chain: string;
}

/**
 * Gateway reports progress as `{ tags: { opName, chain }, data }`, firing twice
 * per step, once on entry and once with the result. Only the pair's identity is
 * interesting here, so they are folded into one line per operation and chain,
 * which is exactly the record of which chains a draw actually touched.
 */
interface GatewayEvent {
  tags?: { opName?: string; chain?: string };
}

function stepRecorder(onStep?: (step: TreasuryStep) => void) {
  const steps: TreasuryStep[] = [];
  const seen = new Set<string>();
  return {
    steps,
    handle(payload: unknown) {
      const tags = (payload as GatewayEvent)?.tags ?? {};
      const step = { name: tags.opName ?? "gateway", chain: tags.chain ?? "aggregate" };
      const id = `${step.name}:${step.chain}`;
      if (seen.has(id)) return;
      seen.add(id);
      steps.push(step);
      onStep?.(step);
    },
  };
}

/**
 * Move USDC from the agent's wallet on one chain into its unified balance.
 *
 * This is the only step that is per-chain, and it happens once rather than per
 * settlement. After it, the funds are not "on Base" any more as far as the agent
 * is concerned; they are simply its balance.
 */
export async function fundReserve(opts: {
  privateKey: string;
  chain: DepositChain;
  amountUsdc: string;
  onStep?: (step: TreasuryStep) => void;
}): Promise<{ amountUsdc: string; chain: DepositChain }> {
  if (!(Number(opts.amountUsdc) > 0)) throw new Error("Deposit amount must be greater than zero.");

  const kit = new UnifiedBalanceKit();
  const recorder = stepRecorder(opts.onStep);
  kit.on("*", (payload) => recorder.handle(payload));

  const deposit = () =>
    kit.deposit({
      from: { adapter: adapterFor(opts.privateKey), chain: opts.chain },
      amount: opts.amountUsdc,
      token: "USDC",
    });

  await deposit();

  return { amountUsdc: opts.amountUsdc, chain: opts.chain };
}

export interface DrawResult {
  amountUsdc: string;
  /** The chains auto-allocation actually drew from, as reported back by the kit. */
  sources: string[];
  steps: TreasuryStep[];
}

/**
 * Draw from the unified balance onto Arc, so the agent can keep settling.
 *
 * No source chain is named. `spend()` reads what the agent holds, orders the
 * chains itself, and constructs one burn intent per chain it needs to touch. The
 * destination uses the Forwarder, so Circle's relayer submits the mint and the
 * agent needs no gas and no signer on Arc at all.
 *
 * Deliberately not retried. A spend that fails after the burn intents are signed
 * may still mint, so retrying could draw the reserve down twice for one shortfall.
 * Same rule the settlement paths follow, for the same reason.
 */
export async function drawToArc(opts: {
  privateKey: string;
  /** The agent's Arc address, which receives the minted USDC. */
  arcAddress: string;
  amountUsdc: string;
  onStep?: (step: TreasuryStep) => void;
}): Promise<DrawResult> {
  if (!opts.arcAddress) throw new Error("No Arc address to mint into.");
  if (!(Number(opts.amountUsdc) > 0)) throw new Error("Top-up amount must be greater than zero.");

  const kit = new UnifiedBalanceKit();
  const recorder = stepRecorder(opts.onStep);
  kit.on("*", (payload) => recorder.handle(payload));

  // No address on the source: a key-backed adapter already knows whose balance it
  // is spending, which is the same key that signs settlement on Arc.
  const result = (await kit.spend({
    from: { adapter: adapterFor(opts.privateKey) },
    to: { chain: SPEND_CHAIN, recipientAddress: opts.arcAddress, useForwarder: true },
    token: "USDC",
    amount: opts.amountUsdc,
  })) as unknown as { allocations?: { chain: string }[] };

  return {
    amountUsdc: opts.amountUsdc,
    sources: [...new Set((result.allocations ?? []).map((a) => a.chain))],
    steps: recorder.steps,
  };
}
