import { NextResponse } from "next/server";
import { ARC_TESTNET_CAIP2, ARC_TESTNET_USDC, unitsToUsdc } from "@/src/arc";
import { STREAMS } from "@/src/streams";

export const runtime = "nodejs";

/**
 * An OpenAPI description of Spigot's paid surface.
 *
 * Served rather than committed as a static file so it cannot drift from the stream
 * catalogue: the prices and stream ids below are read from the same module the
 * seller endpoint prices against.
 *
 * The paid endpoint is x402-gated, which OpenAPI has no native vocabulary for, so
 * the 402 response and the payment headers are documented explicitly. An agent
 * reading this should be able to pay without reading our source.
 */

export async function GET() {
  const base = process.env.SPIGOT_PUBLIC_URL ?? "https://spigot-taupe.vercel.app";
  const streamIds = STREAMS.map((s) => s.id);

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Spigot metered streams",
      version: "1.0.0",
      summary: "Per-second metered market data, paid in USDC over x402.",
      description: [
        "Spigot sells continuous services by the second rather than by the request.",
        "",
        "A buyer meters how long it holds a stream, then pays for that time in blocks.",
        "Each request to the paid endpoint quotes a 402 challenge priced at exactly the",
        "amount the caller states it owes, so a block can be any size the buyer's own",
        "meter arrived at. Payment and delivery are the same request: the response body",
        "to a paid call is the next chunk of the stream. Stop paying and the chunk never",
        "arrives.",
        "",
        "Settlement runs on Arc, where USDC is the native gas token. Paying through",
        "Circle Gateway (Nanopayments) makes each block gas-free and sub-cent, because",
        "the authorisation is signed off-chain and Circle batches the on-chain",
        "settlement.",
      ].join("\n"),
      license: { name: "MIT", identifier: "MIT" },
      contact: { name: "Rising Technology", url: "https://github.com/Risingtell/spigot" },
    },
    servers: [{ url: base, description: "Production" }],
    tags: [
      { name: "streams", description: "Paid metered streams" },
      { name: "proof", description: "Free, read-only evidence endpoints" },
    ],
    "x-payment": {
      protocol: "x402",
      x402Version: 2,
      scheme: "exact",
      network: ARC_TESTNET_CAIP2,
      asset: ARC_TESTNET_USDC,
      assetDecimals: 6,
      facilitator: "Circle Gateway (batched)",
      batching: {
        extra: { name: "GatewayWalletBatched", version: "1" },
        note: "Sign the Gateway-batched authorisation to settle gas-free. A plain transfer also works but pays gas.",
      },
      pricing: "Per second of stream held, quoted per block. See x-streams for rates.",
    },
    "x-streams": STREAMS.map((s) => ({
      id: s.id,
      title: s.title,
      provider: s.provider,
      description: s.description,
      ratePerSecondUsd: unitsToUsdc(s.ratePerSecond),
      ratePerSecondUnits: s.ratePerSecond,
    })),
    paths: {
      "/api/stream/tick": {
        get: {
          tags: ["streams"],
          operationId: "buyStreamBlock",
          summary: "Buy one metered block of a stream and receive the next chunk",
          description: [
            "Call without a payment to receive a 402 carrying the payment requirements",
            "for the block size you asked for. Sign the returned requirements and call",
            "again with the PAYMENT-SIGNATURE header to receive the chunk.",
            "",
            "`units` is the amount owed for the block, in USDC smallest units, as",
            "computed by the caller's own meter. The challenge is priced at exactly that",
            "amount, so the payment can never disagree with the meter.",
          ].join("\n"),
          parameters: [
            {
              name: "stream",
              in: "query",
              required: true,
              description: "Which stream to draw from.",
              schema: { type: "string", enum: streamIds },
            },
            {
              name: "units",
              in: "query",
              required: true,
              description: "Amount owed for this block, in USDC smallest units (6 decimals). Max 1000000, which is $1.",
              schema: { type: "integer", format: "int64", minimum: 1, maximum: 1_000_000 },
            },
          ],
          responses: {
            "200": {
              description: "Paid. The body is the next chunk of the stream.",
              headers: {
                "PAYMENT-RESPONSE": {
                  description: "Base64 JSON settlement receipt from the facilitator.",
                  schema: { type: "string" },
                },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/StreamChunk" },
                },
              },
            },
            "400": { description: "Missing or unusable units, or a block above the per-block ceiling." },
            "402": {
              description: "Payment required. The body and the PAYMENT-REQUIRED header carry identical requirements.",
              headers: {
                "PAYMENT-REQUIRED": {
                  description: "Base64 JSON of the same challenge carried in the body.",
                  schema: { type: "string" },
                },
              },
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PaymentRequired" } },
              },
            },
            "404": { description: "Unknown stream id." },
            "503": { description: "This provider has no payout address configured." },
          },
        },
      },
      "/api/impact": {
        get: {
          tags: ["proof"],
          operationId: "getImpact",
          summary: "The public record of everything this provider has been paid",
          description:
            "Holds no database. Direct settlements are read from Arc's USDC transfer log and gas-free settlements from Circle's Gateway API, on request.",
          responses: {
            "200": {
              description: "Settlement totals, with the source of each figure named.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/fee": {
        get: {
          tags: ["proof"],
          operationId: "getFeeMarket",
          summary: "Arc's live fee market and the settlement cadence it implies",
          responses: {
            "200": { description: "Live gas price, cost per settlement, and cadence by stream price." },
          },
        },
      },
    },
    components: {
      schemas: {
        StreamChunk: {
          type: "object",
          required: ["stream", "chunk", "paidUnits", "network"],
          properties: {
            stream: { type: "string", enum: streamIds },
            paidUnits: { type: "string", description: "Units settled for this block." },
            settlement: { type: ["string", "null"], description: "Facilitator settlement id." },
            network: { type: "string", example: ARC_TESTNET_CAIP2 },
            chunk: {
              type: "object",
              description: "The delivered content. Shape depends on the stream.",
              properties: {
                asset: { type: "string", example: "BTC-USD" },
                source: { type: "string", example: "coinbase exchange ticker" },
                price: { type: "number" },
                bid: { type: "number" },
                ask: { type: "number" },
                tradesPerSecond: { type: "number", description: "Market activity across the rolling window." },
                movementBps: { type: "number" },
                spreadBps: { type: "number" },
                windowSamples: { type: "integer" },
                observedAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
        PaymentRequired: {
          type: "object",
          required: ["x402Version", "accepts"],
          properties: {
            x402Version: { type: "integer", example: 2 },
            resource: {
              type: "object",
              properties: {
                url: { type: "string" },
                description: { type: "string" },
                mimeType: { type: "string" },
              },
            },
            accepts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  scheme: { type: "string", example: "exact" },
                  network: { type: "string", example: ARC_TESTNET_CAIP2 },
                  asset: { type: "string", example: ARC_TESTNET_USDC },
                  amount: { type: "string", description: "USDC smallest units owed." },
                  payTo: { type: "string" },
                  maxTimeoutSeconds: { type: "integer" },
                  extra: {
                    type: "object",
                    description: "EIP-712 domain. GatewayWalletBatched selects gas-free batched settlement.",
                  },
                },
              },
            },
          },
        },
      },
      securitySchemes: {
        x402Payment: {
          type: "apiKey",
          in: "header",
          name: "PAYMENT-SIGNATURE",
          description:
            "Base64 JSON x402 payment payload signed against the requirements returned by the 402. Not a credential: it authorises one payment for one block and cannot be reused.",
        },
      },
    },
  };

  return NextResponse.json(spec, {
    headers: { "cache-control": "public, max-age=300" },
  });
}
