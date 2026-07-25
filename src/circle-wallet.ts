/**
 * Circle developer-controlled wallets on Arc Testnet.
 *
 * Each autonomous agent, and each service provider, is a real Circle wallet on
 * Arc. The agent holds USDC and pays providers directly, wallet to wallet, with
 * a real on-chain transaction per tick. Adapted from the proven Arc wallet layer
 * shipped in Driplet; the framework binding (`server-only`) is removed so this
 * core runs anywhere - a Node agent, a worker, or a Next.js route.
 */

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { ARC_BLOCKCHAIN, ARC_TESTNET_USDC, USDC_DECIMALS, arcTxUrl } from "./arc";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
const walletSetId = process.env.CIRCLE_WALLET_SET_ID;

/** True when Circle creds are present so live settlement is possible. */
export function circleConfigured(): boolean {
  return Boolean(apiKey && entitySecret && walletSetId);
}

type Client = ReturnType<typeof initiateDeveloperControlledWalletsClient>;
let _client: Client | null = null;
function client(): Client {
  if (!apiKey || !entitySecret) throw new Error("Circle is not configured (CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET).");
  if (!_client) _client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  return _client;
}

export interface ArcWallet {
  id: string;
  address: string;
}

/** Create a developer-controlled wallet on Arc Testnet (refId = agent/provider label). */
export async function createArcWallet(refId: string): Promise<ArcWallet> {
  if (!walletSetId) throw new Error("Circle is not configured (CIRCLE_WALLET_SET_ID).");
  const res = await client().createWallets({
    walletSetId,
    blockchains: [ARC_BLOCKCHAIN],
    count: 1,
    accountType: "EOA",
    metadata: [{ refId }],
  });
  const wallet = res.data?.wallets?.[0];
  if (!wallet) throw new Error("Wallet creation failed.");
  return { id: wallet.id, address: wallet.address };
}

/** USDC balance (whole USDC) for a wallet, plus the USDC token id for transfers. */
export async function getUsdc(walletId: string): Promise<{ amount: number; tokenId: string | null }> {
  const res = await client().getWalletTokenBalance({ id: walletId });
  const balances = res.data?.tokenBalances ?? [];
  const usdc = balances.find((b) => (b.token?.symbol ?? "").toUpperCase().includes("USDC"));
  return { amount: usdc ? Number(usdc.amount) : 0, tokenId: usdc?.token?.id ?? null };
}

const FAILURE_STATES = new Set(["CANCELLED", "DENIED", "FAILED", "STUCK"]);

/** Poll a Circle transaction until it's on-chain (or fails) and return its tx hash. */
async function waitForTransaction(id: string, timeoutMs = 45_000): Promise<{ state: string; txHash?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await client().getTransaction({
      id,
      waitForState: "CONFIRMED",
      pollingInterval: 2000,
      signal: controller.signal,
    });
    const tx = res.data?.transaction;
    return { state: tx?.state ?? "UNKNOWN", txHash: tx?.txHash };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pay `amountUnits` USDC (smallest units) from an agent wallet to a provider
 * address on Arc and wait for it to confirm. Returns the real tx hash and explorer
 * link. This is one settled block of stream time.
 *
 * It settles by calling `transfer(address,uint256)` on Arc's USDC contract rather
 * than issuing a generic token transfer. Both move the same money, but an explicit
 * ERC-20 call is guaranteed to emit a `Transfer` event, which is what makes the
 * settlement independently re-derivable from the chain by anyone (see
 * `src/verify.ts`). Provable beats convenient.
 */
export async function payAndConfirm(opts: {
  walletId: string;
  to: string;
  amountUnits: string;
}): Promise<{ txHash: string; explorerUrl: string; state: string }> {
  const units = BigInt(opts.amountUnits);
  if (units <= 0n) throw new Error("Nothing to settle.");

  const { tokenId, amount } = await getUsdc(opts.walletId);
  if (!tokenId) throw new Error("No USDC in the agent wallet to settle this block.");
  const balanceUnits = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
  if (units > balanceUnits) throw new Error("Settlement amount exceeds the agent's balance.");

  const created = await client().createContractExecutionTransaction({
    walletId: opts.walletId,
    contractAddress: ARC_TESTNET_USDC,
    abiFunctionSignature: "transfer(address,uint256)",
    abiParameters: [opts.to, opts.amountUnits],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const txId = created.data?.id;
  if (!txId) throw new Error("Settlement could not be initiated.");

  const result = await waitForTransaction(txId);
  if (FAILURE_STATES.has(result.state)) throw new Error(`Settlement ${result.state.toLowerCase()}.`);
  if (!result.txHash) throw new Error("Settlement is still confirming.");

  return { txHash: result.txHash, explorerUrl: arcTxUrl(result.txHash), state: result.state };
}
