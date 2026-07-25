/**
 * ArcSettlementProvider - the bridge that makes meter402's streaming meter settle
 * for real on Arc.
 *
 * meter402 is chain-agnostic: it quotes what each tick owes and, once the tick is
 * paid, records the settlement with a real tx hash. This provider is the "pay it"
 * half on Arc - it takes a quoted tick and moves that exact USDC from the agent's
 * Circle wallet to the provider, wallet to wallet, then hands the on-chain hash
 * back to the meter. Swap MockSettlementProvider for this and the same streaming
 * loop becomes real money on Arc, unchanged.
 */

import type { SettlementProvider, TickQuote, SettlementResult } from "meter402";
import { ARC_TESTNET_CAIP2 } from "./arc";
import { payAndConfirm } from "./circle-wallet";

export class ArcSettlementProvider implements SettlementProvider {
  readonly network = ARC_TESTNET_CAIP2;
  readonly mock = false;

  /**
   * `session.agent` carries the agent's Circle wallet id; `stream.payTo` is the
   * provider's Arc address. One tick = one confirmed USDC transfer on Arc.
   */
  async settle(quote: TickQuote): Promise<SettlementResult> {
    const walletId = quote.session.agent;
    const to = quote.stream.payTo;
    if (!to) throw new Error(`stream ${quote.stream.id} has no payTo address`);

    if (BigInt(quote.amount) <= 0n) {
      // Nothing owed settles nothing; hand back an empty result so the meter
      // advances without a bogus transfer.
      return { txHash: "", explorerUrl: "", network: this.network };
    }

    const { txHash, explorerUrl } = await payAndConfirm({ walletId, to, amountUnits: quote.amount });
    return { txHash, explorerUrl, network: this.network };
  }
}
