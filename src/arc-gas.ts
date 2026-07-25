/**
 * Settlement economics on Arc.
 *
 * Per-second billing only works if the chain fee under each settlement is small
 * next to the money it moves. Arc prices gas in USDC itself, so that ratio is
 * directly measurable: read the live base fee, multiply by the gas one USDC
 * transfer burns, and you have the exact cost of settling once, denominated in
 * the same units the meter bills in.
 *
 * That number is what stops Spigot from being a toy. At the time of writing Arc
 * quotes roughly 22 gwei, so one settlement costs about $0.0014 - more than a
 * whole second of a $0.001/sec stream. Settling literally every second would
 * hand the chain more than the provider earns. So the agent meters every second
 * and settles on the cadence the fee market allows, which is what
 * `minEconomicSettlementUnits` computes.
 */

import { ARC_TESTNET_RPC, USDC_UNIT, weiToUnits } from "./arc";

/** Gas burned by one ERC-20 USDC transfer on Arc. Measured, then rounded up. */
export const SETTLEMENT_GAS_LIMIT = 65_000n;

/**
 * Arc's documented testnet base-fee floor, used only when the RPC cannot be
 * reached. Quoting the floor understates the real cost, so anything derived from
 * it is labelled `fallback` and never presented as a live measurement.
 */
export const ARC_BASE_FEE_FLOOR_GWEI = 20n;

export interface SettlementCost {
  /** Live gas price in wei (Arc's 18-decimal native view of USDC). */
  gasPriceWei: string;
  gasPriceGwei: number;
  gasLimit: string;
  /** What one settlement costs, in USDC smallest units (6 decimals). */
  costUnits: string;
  costUsd: number;
  /** Whether this came off the chain or off the documented floor. */
  source: "live" | "fallback";
  measuredAt: number;
}

/** Price one settlement from a gas price, with no network access. */
export function settlementCostFrom(
  gasPriceWei: bigint,
  gasLimit: bigint = SETTLEMENT_GAS_LIMIT,
  source: SettlementCost["source"] = "live",
): SettlementCost {
  const costUnits = weiToUnits(gasPriceWei * gasLimit);
  return {
    gasPriceWei: gasPriceWei.toString(),
    gasPriceGwei: Number(gasPriceWei) / 1e9,
    gasLimit: gasLimit.toString(),
    costUnits: costUnits.toString(),
    costUsd: Number(costUnits) / USDC_UNIT,
    source,
    measuredAt: Date.now(),
  };
}

/** Minimal JSON-RPC call against Arc. No dependencies, just fetch. */
async function rpc(url: string, method: string, params: unknown[], timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Arc RPC ${method} returned ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? `Arc RPC ${method} failed`);
    if (!body.result) throw new Error(`Arc RPC ${method} returned no result`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read Arc's live gas price and price one settlement against it. Falls back to
 * the documented fee floor if the RPC is unreachable, and says so in `source`.
 */
export async function fetchSettlementCost(opts: {
  rpcUrl?: string;
  gasLimit?: bigint;
  timeoutMs?: number;
} = {}): Promise<SettlementCost> {
  const gasLimit = opts.gasLimit ?? SETTLEMENT_GAS_LIMIT;
  try {
    const hex = await rpc(opts.rpcUrl ?? ARC_TESTNET_RPC, "eth_gasPrice", [], opts.timeoutMs ?? 6000);
    return settlementCostFrom(BigInt(hex), gasLimit, "live");
  } catch {
    return settlementCostFrom(ARC_BASE_FEE_FLOOR_GWEI * 1_000_000_000n, gasLimit, "fallback");
  }
}

/**
 * The smallest amount worth settling: below this, the chain fee eats more than
 * `maxOverheadRatio` of the value moved, so the agent keeps metering and waits.
 */
export function minEconomicSettlementUnits(costUnits: string, maxOverheadRatio: number): bigint {
  if (!(maxOverheadRatio > 0)) throw new Error("maxOverheadRatio must be greater than zero.");
  if (maxOverheadRatio >= 1) return 0n;
  return BigInt(Math.ceil(Number(costUnits) / maxOverheadRatio));
}

/** How many seconds of a stream it takes to reach that minimum, for display. */
export function economicSettlementSeconds(minUnits: bigint, ratePerSecondUnits: string): number {
  const rate = Number(ratePerSecondUnits);
  if (rate <= 0) return 0;
  return Number(minUnits) / rate;
}

/** Chain fee as a share of the value moved, once a settlement actually lands. */
export function overheadRatio(costUnits: string, settledUnits: string): number {
  const settled = Number(settledUnits);
  if (settled <= 0) return 1;
  return Number(costUnits) / settled;
}
