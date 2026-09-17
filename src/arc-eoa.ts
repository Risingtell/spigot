/**
 * Settling from a plain Arc key.
 *
 * The Circle-wallet path (`src/arc-provider.ts`) is the one an operator with an
 * organisation and a wallet set will want. This is the other one: an agent holding
 * nothing but a private key and some USDC. It exists because the
 * shortest path from "clone the repo" to "watch real money move on Arc" should not
 * run through an account signup.
 *
 * Both paths settle the same way on-chain - an explicit
 * `transfer(address,uint256)` call against Arc's USDC contract - so both emit the
 * `Transfer` event that makes every settlement independently re-derivable from the
 * chain by anyone with the agent's address (see `src/verify.ts`).
 */

import { createPublicClient, createWalletClient, defineChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SettlementProvider, SettlementResult, TickQuote } from "meter402";
import { pacedTransport } from "./chain";
import { ARC, arcTxUrl } from "./arc";

/**
 * Arc for viem, whichever network `ARC` resolved to. The native currency is USDC
 * at 18 decimals, which is the gas-side view of the same balance the ERC-20
 * reports at 6. One pool of funds, two views: never add them together.
 */
export const arcChain = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc] } },
  blockExplorers: { default: { name: "Arc Explorer", url: ARC.explorer } },
  testnet: ARC.type === "testnet",
});

const ERC20_TRANSFER = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** True when a key is configured, so real settlement is possible. */
export function arcKeyConfigured(): boolean {
  return Boolean(process.env.SPIGOT_ARC_KEY);
}

function normalisedKey(key: string): Hex {
  const trimmed = key.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
}

export interface ArcEoaOptions {
  /** The agent's Arc private key. Read from SPIGOT_ARC_KEY when omitted. */
  privateKey?: string;
  rpcUrl?: string;
}

/**
 * Settles each block of stream time as a real USDC transfer on Arc, signed by the
 * agent's own key and confirmed before the meter records it.
 */
export class ArcEoaSettlementProvider implements SettlementProvider {
  readonly network = ARC.caip2;
  readonly mock = false;
  readonly address: string;

  private readonly wallet;
  private readonly publicClient;

  constructor(opts: ArcEoaOptions = {}) {
    const key = opts.privateKey ?? process.env.SPIGOT_ARC_KEY;
    if (!key) throw new Error("No Arc key: set SPIGOT_ARC_KEY to settle on Arc.");

    const account = privateKeyToAccount(normalisedKey(key));
    // Not viem's plain http transport: Arc throttles, and polling a receipt after
    // a settlement is exactly the burst that trips it.
    const transport = pacedTransport();
    this.address = account.address;
    this.wallet = createWalletClient({ account, chain: arcChain, transport });
    this.publicClient = createPublicClient({ chain: arcChain, transport });
  }

  /** The agent's USDC balance in smallest units, read from the ERC-20 view. */
  async balanceUnits(): Promise<bigint> {
    return this.publicClient.readContract({
      address: ARC.usdc as Hex,
      abi: ERC20_TRANSFER,
      functionName: "balanceOf",
      args: [this.address as Hex],
    });
  }

  async settle(quote: TickQuote): Promise<SettlementResult> {
    const to = quote.stream.payTo;
    if (!to) throw new Error(`stream ${quote.stream.id} has no payTo address`);

    const units = BigInt(quote.amount);
    if (units <= 0n) return { txHash: "", explorerUrl: "", network: this.network };

    const txHash = await this.wallet.writeContract({
      address: ARC.usdc as Hex,
      abi: ERC20_TRANSFER,
      functionName: "transfer",
      args: [to as Hex, units],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`Settlement reverted on Arc (${txHash}).`);

    return { txHash, explorerUrl: arcTxUrl(txHash), network: this.network };
  }
}
