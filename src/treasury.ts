/**
 * The agent's treasury: keeping the Arc wallet funded without a human.
 *
 * A streaming agent has a failure mode a per-request agent does not. It is
 * mid-stream, holding something it is actively paying for by the second, when its
 * Arc wallet runs dry. Waiting for a person to notice and top it up is exactly the
 * autonomy gap the Agentic Economy track is about, so the agent watches its own
 * balance and pulls USDC across chains itself, using CCTP through Circle's Bridge
 * Kit.
 *
 * The shape this takes: the agent spends from a Circle wallet on Arc and holds a
 * reserve on another chain. When the spending balance falls below the floor its
 * policy sets, it burns from the reserve and mints into its own Arc address.
 * Circle's Forwarder submits the mint, so the agent needs no signer on Arc at all
 * and the destination is just an address.
 *
 * Arc is CCTP domain 26 (see `ARC_CCTP_DOMAIN`); Bridge Kit ships the Arc Testnet
 * definition, so the route is a first-class one rather than something hand-rolled.
 */

import { ArcTestnet, BridgeKit, type BridgeResult } from "@circle-fin/bridge-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { USDC_UNIT, unitsToUsdc, usdcToUnits } from "./arc";

/** Where the agent keeps the reserve it tops up from. */
export type ReserveChain =
  | "Ethereum_Sepolia"
  | "Base_Sepolia"
  | "Avalanche_Fuji"
  | "Arbitrum_Sepolia"
  | "Optimism_Sepolia"
  | "Polygon_Amoy_Testnet";

export interface TreasuryPolicy {
  /** Top up once the Arc balance falls below this, in USDC smallest units. */
  floorUnits: string;
  /** Bring the Arc balance back up to this, in USDC smallest units. */
  targetUnits: string;
  /** Chain the reserve is held on. */
  reserveChain: ReserveChain;
}

export interface TopUpPlan {
  needed: boolean;
  balanceUnits: string;
  floorUnits: string;
  /** Whole USDC to bridge, as the string Bridge Kit expects. Empty when not needed. */
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

export interface TopUpOptions {
  /** Key controlling the reserve on the source chain. Never the Arc spending wallet. */
  reservePrivateKey: string;
  /** The agent's Arc address, which receives the minted USDC. */
  arcAddress: string;
  policy: TreasuryPolicy;
  /** Whole USDC to move, as produced by `planTopUp`. */
  amountUsdc: string;
  /** Progress callback: approve, burn, attestation, mint. */
  onStep?: (step: { name: string; state: string; txHash?: string; explorerUrl?: string }) => void;
}

/**
 * Execute one cross-chain top-up into the agent's Arc wallet over CCTP.
 * Returns Bridge Kit's result, including a tx hash per step.
 */
export async function topUpArc(opts: TopUpOptions): Promise<BridgeResult> {
  if (!opts.reservePrivateKey) throw new Error("No reserve key: the agent cannot move its own funds.");
  if (!opts.arcAddress) throw new Error("No Arc address to mint into.");
  if (!(Number(opts.amountUsdc) > 0)) throw new Error("Top-up amount must be greater than zero.");

  const kit = new BridgeKit();
  if (opts.onStep) {
    kit.on("*", (payload) => {
      const step = payload.values;
      opts.onStep?.({
        name: payload.method,
        state: step.state,
        txHash: step.txHash,
        explorerUrl: step.explorerUrl,
      });
    });
  }

  const reserve = createViemAdapterFromPrivateKey({ privateKey: opts.reservePrivateKey });

  return kit.bridge({
    from: { adapter: reserve, chain: opts.policy.reserveChain },
    // Forwarder-only destination: Circle's relayer submits the mint on Arc, so the
    // agent needs no key on the chain it is being funded into.
    to: { chain: ArcTestnet, recipientAddress: opts.arcAddress, useForwarder: true },
    amount: opts.amountUsdc,
  });
}

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
