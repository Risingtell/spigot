/**
 * Arc network constants. Arc is Circle's stablecoin-native L1 - USDC is the gas
 * token and settlement is sub-second, which is what makes per-second streaming
 * settlement practical instead of theoretical.
 *
 * Spigot settles on Arc mainnet. Testnet is kept as a switch so the whole live
 * path can be exercised for free: set SPIGOT_NETWORK=testnet and every module
 * that touches the chain follows, because they all read `ARC` rather than a
 * network-specific constant.
 */

export type ArcNetworkType = "mainnet" | "testnet";

export interface ArcNetwork {
  /** Human name, as the console and the CLIs print it. */
  name: string;
  type: ArcNetworkType;
  chainId: number;
  /** CAIP-2 network id used by the Circle x402 / Gateway stack and meter402. */
  caip2: `eip155:${number}`;
  /** Public JSON-RPC endpoint. Anyone can re-derive Spigot's numbers from this. */
  rpc: string;
  explorer: string;
  /** Native USDC (6 decimals on the ERC-20 view). Same address on both networks. */
  usdc: `0x${string}`;
  /** Circle blockchain slug for developer-controlled wallets. */
  circleBlockchain: "ARC" | "ARC-TESTNET";
  /** Chain key for Circle's x402-batching GatewayClient. */
  gatewayChain: "arc" | "arcTestnet";
  /** Gateway facilitator base URL. The SDK defaults to mainnet, so pass it always. */
  gatewayApi: string;
  /** Circle's Gateway wallet contract on this network: deposits land here. */
  gatewayWallet: `0x${string}`;
  /** Chain name in Circle's Unified Balance Kit. */
  ubkChain: "Arc" | "Arc_Testnet";
  /** Where free USDC comes from, when it does. */
  faucet?: string;
}

export const ARC_MAINNET: ArcNetwork = {
  name: "Arc",
  type: "mainnet",
  chainId: 5042,
  caip2: "eip155:5042",
  rpc: "https://rpc.mainnet.arc.io",
  explorer: "https://explorer.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  circleBlockchain: "ARC",
  gatewayChain: "arc",
  gatewayApi: "https://gateway-api.circle.com",
  gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
  ubkChain: "Arc",
};

export const ARC_TESTNET: ArcNetwork = {
  name: "Arc Testnet",
  type: "testnet",
  chainId: 5042002,
  caip2: "eip155:5042002",
  rpc: "https://rpc.testnet.arc.io",
  explorer: "https://explorer.testnet.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  circleBlockchain: "ARC-TESTNET",
  gatewayChain: "arcTestnet",
  gatewayApi: "https://gateway-api-testnet.circle.com",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  ubkChain: "Arc_Testnet",
  faucet: "https://faucet.circle.com",
};

/** Pick the network from the environment. Mainnet unless told otherwise. */
export function selectNetwork(env: string | undefined = process.env.SPIGOT_NETWORK): ArcNetwork {
  const wanted = (env ?? "").trim().toLowerCase();
  if (wanted === "" || wanted === "mainnet") return ARC_MAINNET;
  if (wanted === "testnet") return ARC_TESTNET;
  throw new Error(`SPIGOT_NETWORK must be "mainnet" or "testnet", not "${env}".`);
}

/** The network everything in this process settles on. */
export const ARC: ArcNetwork = selectNetwork();

/** Arc's CCTP / Gateway domain, the same on both networks. */
export const ARC_CCTP_DOMAIN = 26;

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

/** Deep link to a transaction on this network's explorer. */
export function arcTxUrl(txHash: string): string {
  return `${ARC.explorer}/tx/${txHash}`;
}

/** Deep link to an address on this network's explorer. */
export function arcAddressUrl(address: string): string {
  return `${ARC.explorer}/address/${address}`;
}

/** Smallest USDC units (string, as meter402 emits) → whole-USDC number. */
export function unitsToUsdc(units: string): number {
  return Number(units) / USDC_UNIT;
}

/** Whole-USDC number → smallest-units string. */
export function usdcToUnits(usdc: number): string {
  return Math.round(usdc * USDC_UNIT).toString();
}
