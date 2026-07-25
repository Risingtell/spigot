/**
 * Arc Testnet constants. Arc is Circle's stablecoin-native L1 - USDC is the gas
 * token and settlement is sub-second, which is what makes per-second streaming
 * settlement practical instead of theoretical.
 */

/** Arc Testnet EVM chain id. */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/** CAIP-2 network id used by the Circle x402 / Gateway stack. */
export const ARC_TESTNET_CAIP2 = "eip155:5042002";

/** Native USDC on Arc Testnet (6 decimals). */
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";

/** Circle blockchain slug for developer-controlled wallets. */
export const ARC_BLOCKCHAIN = "ARC-TESTNET" as const;

/** Public JSON-RPC endpoint. Anyone can re-derive Spigot's numbers from this. */
export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";

/** Arc's CCTP domain, used when bridging USDC in from another chain. */
export const ARC_CCTP_DOMAIN = 26;

export const ARC_EXPLORER = "https://testnet.arcscan.app";

/** USDC has 6 decimals; one whole USDC is 1_000_000 smallest units. */
export const USDC_DECIMALS = 6;
export const USDC_UNIT = 1_000_000;

/**
 * Arc exposes the same USDC two ways: the ERC-20 view has 6 decimals, and the
 * native view used for gas and msg.value has 18. They are one pool of funds, not
 * two assets, so gas priced in native wei converts straight into the 6-decimal
 * units the meter bills in - divide by 10^12, never add the two together.
 */
export const NATIVE_PER_USDC_UNIT = 1_000_000_000_000n;

/** Native wei (18dp gas math) → USDC smallest units (6dp billing), rounded up. */
export function weiToUnits(wei: bigint): bigint {
  const whole = wei / NATIVE_PER_USDC_UNIT;
  return wei % NATIVE_PER_USDC_UNIT === 0n ? whole : whole + 1n;
}

/** Deep link to a transaction on the Arc Testnet explorer. */
export function arcTxUrl(txHash: string): string {
  return `${ARC_EXPLORER}/tx/${txHash}`;
}

/** Smallest USDC units (string, as meter402 emits) → whole-USDC number. */
export function unitsToUsdc(units: string): number {
  return Number(units) / USDC_UNIT;
}

/** Whole-USDC number → smallest-units string. */
export function usdcToUnits(usdc: number): string {
  return Math.round(usdc * USDC_UNIT).toString();
}
