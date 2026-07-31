/**
 * Settling through Circle Nanopayments.
 *
 * The two settlement paths in `arc-eoa.ts` and `arc-provider.ts` each broadcast a
 * real transaction per block, which is why the agent has to schedule around the
 * fee. Nanopayments removes that constraint: the agent signs an authorisation
 * off-chain, Circle Gateway credits the provider instantly against a ledger, and
 * the on-chain settlement is batched across thousands of payments. Gas per block
 * goes to zero and a block can be worth a fraction of a cent.
 *
 * That does not make Spigot's job smaller, it makes it clearer. Gateway decides
 * how a payment settles. It does not decide whether the next second is worth
 * buying. The budget, the rate ceiling and the value signal stay exactly where
 * they were, and this provider wires them into Gateway's own pre-signature hook,
 * so a payment the policy rejects is never signed at all.
 *
 * The gate is literal here in a way it is not on the direct paths: the agent pays
 * an x402-protected endpoint, and the response body IS the next chunk of the
 * stream. Stop paying and the chunk never arrives.
 */

import { GatewayClient } from "@circle-fin/x402-batching/client";
import type { SettlementProvider, SettlementResult, TickQuote } from "meter402";
import { ARC_TESTNET_CAIP2, ARC_TESTNET_RPC, arcTxUrl, unitsToUsdc } from "./arc";
import { withRetry } from "./retry";

/** Circle's Gateway chain key for Arc Testnet. Domain 26, chain id 5042002. */
export const GATEWAY_CHAIN = "arcTestnet" as const;

/**
 * The testnet facilitator. The SDK defaults to the mainnet endpoint even when the
 * configured chain is a testnet, so this has to be passed explicitly on both the
 * buyer and the seller side.
 */
export const GATEWAY_TESTNET_API = "https://gateway-api-testnet.circle.com";

/** Keep at least this much in the Gateway balance, in whole USDC. */
const MIN_GATEWAY_BALANCE = 0.5;
/** Top the Gateway balance up to this when it runs low. */
const GATEWAY_TARGET = 2;

export interface NanoOptions {
  /** The agent's Arc key. Read from SPIGOT_ARC_KEY when omitted. */
  privateKey?: string;
  /** Base URL of the metered stream seller, e.g. http://localhost:3000 */
  sellerBaseUrl: string;
  rpcUrl?: string;
  /**
   * Consulted before Gateway signs anything. Returning a reason aborts the
   * payment before a signature exists. The agent has already made this decision
   * once; enforcing it again here means no code path can pay around the policy.
   */
  policyCheck?: (amountUnits: string) => string | null;
}

/** True when an Arc key is configured, so Nanopayments settlement is possible. */
export function nanoConfigured(): boolean {
  return Boolean(process.env.SPIGOT_ARC_KEY);
}

export class NanoSettlementProvider implements SettlementProvider {
  readonly network = ARC_TESTNET_CAIP2;
  readonly mock = false;
  readonly address: string;

  private readonly gateway: GatewayClient;
  private readonly sellerBaseUrl: string;

  constructor(opts: NanoOptions) {
    const key = opts.privateKey ?? process.env.SPIGOT_ARC_KEY;
    if (!key) throw new Error("No Arc key: set SPIGOT_ARC_KEY to settle through Gateway.");

    const privateKey = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    this.gateway = new GatewayClient({
      chain: GATEWAY_CHAIN,
      privateKey,
      rpcUrl: opts.rpcUrl ?? ARC_TESTNET_RPC,
    });
    this.address = this.gateway.account.address;
    this.sellerBaseUrl = opts.sellerBaseUrl.replace(/\/$/, "");

    // Gateway's own hook, carrying Spigot's policy. A block the policy refuses
    // never becomes a signature.
    if (opts.policyCheck) {
      this.gateway.onBeforePaymentCreation(async (ctx) => {
        const amount = String(ctx?.selectedRequirements?.amount ?? "0");
        const reason = opts.policyCheck?.(amount);
        if (reason) return { abort: true as const, reason };
      });
    }
  }

  /** USDC sitting in the wallet, in smallest units. */
  async walletUnits(): Promise<bigint> {
    return withRetry(async () => (await this.gateway.getUsdcBalance()).balance, { label: "getUsdcBalance" });
  }

  /** USDC available to spend inside Gateway, in smallest units. */
  async gatewayUnits(): Promise<bigint> {
    return withRetry(async () => (await this.gateway.getBalance()).available, { label: "getGatewayBalance" });
  }

  /**
   * Make sure there is spendable balance inside Gateway before a stream opens.
   * Depositing is an on-chain transaction; it happens once, not per block, which
   * is the whole point.
   */
  async ensureFunded(): Promise<{ deposited: boolean; availableUnits: bigint; txHash?: string }> {
    const available = await this.gatewayUnits();
    if (unitsToUsdc(available.toString()) >= MIN_GATEWAY_BALANCE) {
      return { deposited: false, availableUnits: available };
    }

    const wallet = await this.walletUnits();
    if (unitsToUsdc(wallet.toString()) < GATEWAY_TARGET) {
      throw new Error(
        `Need at least ${GATEWAY_TARGET} USDC in ${this.address} to fund Gateway. ` +
          `Top it up at https://faucet.circle.com (Arc Testnet).`,
      );
    }

    const result = await withRetry(() => this.gateway.deposit(GATEWAY_TARGET.toFixed(2)), {
      label: "deposit",
      attempts: 2,
      baseDelayMs: 1500,
    });
    return { deposited: true, availableUnits: await this.gatewayUnits(), txHash: result.depositTxHash };
  }

  /**
   * Settle one block by buying the next chunk of the stream. The seller prices the
   * 402 challenge at exactly what this block owes, so the payment and the meter
   * can never drift apart.
   */
  async settle(quote: TickQuote): Promise<SettlementResult> {
    const units = BigInt(quote.amount);
    if (units <= 0n) return { txHash: "", explorerUrl: "", network: this.network };

    const url = `${this.sellerBaseUrl}/api/stream/tick?stream=${encodeURIComponent(quote.stream.id)}&units=${units}`;

    /**
     * Deliberately not retried.
     *
     * `pay()` signs an authorisation and hands it to the seller, who settles it.
     * If the call fails after the seller already settled, the money has moved and
     * only the response was lost, so retrying would authorise the same block a
     * second time. The agent treats a failed payment the same way it treats a
     * failed on-chain settlement: close the session on the record rather than risk
     * paying twice for the same seconds. Every read around it retries freely,
     * because a read cannot double-spend.
     */
    const result = await this.gateway.pay<{ chunk?: unknown }>(url);

    if (result.amount !== units) {
      throw new Error(`Gateway settled ${result.amount} units for a block owing ${units}.`);
    }

    // Gateway returns a settlement id immediately; the batched on-chain transfer
    // that carries it lands later. Record the id either way, and only link out to
    // the explorer when what we hold is genuinely an on-chain hash.
    const isOnChainHash = /^0x[0-9a-fA-F]{64}$/.test(result.transaction ?? "");
    return {
      txHash: result.transaction ?? "",
      explorerUrl: isOnChainHash ? arcTxUrl(result.transaction) : "",
      network: this.network,
    };
  }
}
