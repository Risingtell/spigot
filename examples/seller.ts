/**
 * Sell something by the second on Arc, in one file.
 *
 *   SPIGOT_PROVIDER_ADDRESS=0xYourPayoutAddress npm run seller
 *
 * This is the other half of Spigot. The agent in this repo is a buyer, and a
 * buyer with nobody to pay proves only half a market, so this is the smallest
 * honest seller: an HTTP endpoint that quotes a price per block of service time,
 * takes a signed USDC payment for it over x402, and hands back the goods.
 *
 * It is deliberately framework-free and deliberately short. If you run a service
 * on Arc and want an agent to be able to buy it by the second, the integration is
 * this file with `produce()` replaced by whatever you actually sell. Nothing here
 * is Spigot-specific: the agent paying you does not need to know who you are, and
 * you do not need to run Spigot to be paid by it.
 *
 * Test it against the buyer in `examples/buy.ts`:
 *
 *   npm run seller                      # terminal one
 *   npm run buy -- http://localhost:4021/sell?units=30000   # terminal two
 */

import { createServer } from "node:http";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { ARC, unitsToUsdc } from "../src/arc";

const PORT = Number(process.env.SELLER_PORT ?? 4021);
const PAYOUT = process.env.SPIGOT_PROVIDER_ADDRESS;

/**
 * The most a single block may cost. A buyer signs what the seller quotes, so an
 * unbounded quote is an invitation to sign away a whole budget in one call. Every
 * seller wants a ceiling, whatever else it changes.
 */
const MAX_BLOCK_UNITS = 1_000_000n; // $1.00

const facilitator = new BatchFacilitatorClient({ url: ARC.gatewayApi });

/**
 * What the buyer is actually paying for. Replace this with your service: a model
 * response, a slice of a feed, the next chunk of a video, an answer to a query.
 * It is called with the block already paid for in principle but not yet settled,
 * which is the ordering that matters - see the note further down.
 */
async function produce(units: bigint): Promise<unknown> {
  return {
    servedAt: new Date().toISOString(),
    boughtUsd: unitsToUsdc(units.toString()),
    payload: "Replace produce() with whatever you sell. This is the goods.",
  };
}

/** The x402 terms for one block: pay this much, in this asset, on this chain. */
function requirementsFor(units: bigint, resource: string) {
  return {
    scheme: "exact" as const,
    network: ARC.caip2,
    asset: ARC.usdc,
    amount: units.toString(),
    payTo: PAYOUT as string,
    maxTimeoutSeconds: 3600,
    /**
     * Tells the buyer to sign a Gateway-batched authorisation rather than a plain
     * transfer. Without this the payment settles on-chain per block and costs gas,
     * which is exactly the economics a per-second seller cannot live with.
     */
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC.gatewayWallet,
    },
  };
}

const json = (res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(text);
};

const server = createServer(async (req, res) => {
  if (!PAYOUT) {
    json(res, 503, { error: "Set SPIGOT_PROVIDER_ADDRESS to the address that should be paid." });
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/sell") {
    json(res, 404, { error: "POST nothing here. The meter is at /sell?units=<usdc smallest units>." });
    return;
  }

  let units: bigint;
  try {
    units = BigInt(url.searchParams.get("units") ?? "0");
  } catch {
    json(res, 400, { error: "units must be an integer number of USDC smallest units (1000000 = $1)." });
    return;
  }
  if (units <= 0n) {
    json(res, 400, { error: "A block must owe something to be worth delivering." });
    return;
  }
  if (units > MAX_BLOCK_UNITS) {
    json(res, 400, { error: "Block price exceeds this seller's per-block ceiling." });
    return;
  }

  const resource = `/sell?units=${units}`;
  const requirements = requirementsFor(units, resource);
  const signature = req.headers["payment-signature"];

  // Unpaid: answer with the price and how to pay it. This is the whole of x402.
  if (!signature || typeof signature !== "string") {
    const challenge = {
      x402Version: 2,
      resource: {
        url: resource,
        description: `One metered block worth $${unitsToUsdc(units.toString()).toFixed(6)} USDC`,
        mimeType: "application/json",
      },
      accepts: [requirements],
    };
    json(res, 402, challenge, {
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(signature, "base64").toString("utf8"));
  } catch {
    json(res, 402, { error: "PAYMENT-SIGNATURE is not valid base64 JSON." });
    return;
  }

  const verified = await facilitator.verify(payload as never, requirements as never);
  if (!verified.isValid) {
    json(res, 402, { error: "Payment rejected", reason: verified.invalidReason });
    return;
  }

  /**
   * Produce before settling, not after.
   *
   * The obvious order is to take the money and then serve, and it is wrong.
   * Producing can be slow or can fail, and if it failed after settlement the
   * buyer would have paid and received an error. In a payments product that is
   * the one failure that must not exist. This way round a seller that cannot
   * deliver simply does not get paid: the authorisation goes unused and the
   * buyer is free to spend it elsewhere.
   */
  let goods: unknown;
  try {
    goods = await produce(units);
  } catch (err) {
    json(res, 503, { error: `Could not produce this block, so it was not charged: ${(err as Error).message}` });
    return;
  }

  const settled = await facilitator.settle(payload as never, requirements as never);
  if (!settled.success) {
    json(res, 402, { error: "Settlement failed", reason: settled.errorReason });
    return;
  }

  json(res, 200, { chunk: goods, settlement: settled.transaction ?? null }, {
    "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settled)).toString("base64"),
  });
});

server.listen(PORT, () => {
  console.log(`Seller listening on http://localhost:${PORT}/sell?units=30000`);
  console.log(`  network:  ${ARC.name} (chain ${ARC.chainId})`);
  console.log(`  paid to:  ${PAYOUT ?? "NOT SET - export SPIGOT_PROVIDER_ADDRESS"}`);
  console.log(`  price:    whatever the buyer asks for, up to $${unitsToUsdc(MAX_BLOCK_UNITS.toString()).toFixed(2)} a block`);
});
