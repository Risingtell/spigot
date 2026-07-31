import { NextResponse } from "next/server";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { ARC_TESTNET_CAIP2, ARC_TESTNET_USDC, unitsToUsdc } from "@/src/arc";
import { GATEWAY_TESTNET_API } from "@/src/nano";
import { chunkFor } from "@/src/streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The provider side of a metered stream: an x402-protected endpoint that hands
 * back the next chunk, and only to an agent that paid for the block it covers.
 *
 * This is what makes the gate real rather than described. There is no separate
 * "delivery" step to trust. Payment and delivery are the same request: the agent
 * signs, Circle Gateway verifies and settles off-chain, and the response body is
 * the chunk. Stop paying and the next chunk simply never arrives.
 *
 * The price is set per request from `units`, so the challenge always matches
 * exactly what the meter says the block owes. Fixed-price endpoints cannot
 * express a stream whose blocks vary with how long they ran.
 */

const GATEWAY_WALLET_ARC_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
/** Gateway allows a long window; a block of stream time is not worth days. */
const MAX_TIMEOUT_SECONDS = 3600;
/** Refuse to price a single block above this, in USDC smallest units. */
const MAX_BLOCK_UNITS = 1_000_000n; // $1.00

// The SDK points at mainnet unless told otherwise, whatever chain is configured.
const facilitator = new BatchFacilitatorClient({ url: GATEWAY_TESTNET_API });

function requirementsFor(units: bigint, sellerAddress: string, resource: string) {
  return {
    scheme: "exact" as const,
    network: ARC_TESTNET_CAIP2,
    asset: ARC_TESTNET_USDC,
    amount: units.toString(),
    payTo: sellerAddress,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    // Tells the buyer to sign a Gateway-batched authorisation rather than a
    // plain transfer. Without this the payment settles on-chain and costs gas.
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: GATEWAY_WALLET_ARC_TESTNET,
    },
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const streamId = url.searchParams.get("stream") ?? "";
  const rawUnits = url.searchParams.get("units") ?? "";

  const sellerAddress = process.env.SPIGOT_PROVIDER_ADDRESS;
  if (!sellerAddress) {
    return NextResponse.json({ error: "This provider has no payout address configured." }, { status: 503 });
  }

  let units: bigint;
  try {
    units = BigInt(rawUnits);
  } catch {
    return NextResponse.json({ error: "units must be an integer number of USDC smallest units." }, { status: 400 });
  }
  if (units <= 0n) {
    return NextResponse.json({ error: "A block must owe something to be worth delivering." }, { status: 400 });
  }
  if (units > MAX_BLOCK_UNITS) {
    // A block this large means the caller is confused, and quoting it would
    // invite an agent to sign away far more than a slice of stream time.
    return NextResponse.json({ error: "Block price exceeds this provider's per-block ceiling." }, { status: 400 });
  }

  const chunk = chunkFor(streamId);
  if (!chunk) return NextResponse.json({ error: `Unknown stream "${streamId}".` }, { status: 404 });

  const resource = `/api/stream/tick?stream=${encodeURIComponent(streamId)}&units=${units}`;
  const requirements = requirementsFor(units, sellerAddress, resource);
  const signature = req.headers.get("payment-signature");

  // Unpaid: answer with what this block costs and how to pay for it.
  if (!signature) {
    const challenge = {
      x402Version: 2,
      resource: {
        url: resource,
        description: `${chunk.title}: one metered block worth $${unitsToUsdc(units.toString()).toFixed(6)} USDC`,
        mimeType: "application/json",
      },
      accepts: [requirements],
    };
    return new NextResponse(JSON.stringify(challenge), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      },
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(signature, "base64").toString("utf8"));
  } catch {
    return NextResponse.json({ error: "PAYMENT-SIGNATURE is not valid base64 JSON." }, { status: 402 });
  }

  const verified = await facilitator.verify(payload as never, requirements as never);
  if (!verified.isValid) {
    return NextResponse.json({ error: "Payment rejected", reason: verified.invalidReason }, { status: 402 });
  }

  /**
   * Produce the chunk BEFORE taking the money.
   *
   * The obvious order is to settle and then serve, and it is wrong. Producing a
   * chunk means calling a live exchange, which can be slow or down, and if it
   * failed after settlement the buyer would have paid and received a 500. In a
   * payments product that is the one failure that must not exist.
   *
   * This way round, a provider that cannot deliver simply does not get paid: the
   * payment authorisation goes unused and the buyer is free to spend it elsewhere.
   * Verification still runs first, so nobody gets a chunk without a valid payment
   * to redeem.
   */
  let chunkBody: unknown;
  try {
    chunkBody = await chunk.next();
  } catch (err) {
    return NextResponse.json(
      {
        error: "Upstream data unavailable, so no payment was taken.",
        reason: (err as Error).message,
      },
      { status: 503 },
    );
  }

  const settled = await facilitator.settle(payload as never, requirements as never);
  if (!settled.success) {
    return NextResponse.json({ error: "Payment not settled", reason: settled.errorReason }, { status: 402 });
  }

  return NextResponse.json(
    {
      stream: streamId,
      chunk: chunkBody,
      paidUnits: units.toString(),
      settlement: settled.transaction ?? null,
      network: ARC_TESTNET_CAIP2,
    },
    {
      headers: settled.transaction
        ? { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settled)).toString("base64") }
        : undefined,
    },
  );
}
