/**
 * Pay any x402 endpoint on Arc, once, from the agent's own wallet.
 *
 *   npm run buy -- https://some-service.example/quote?units=10000
 *
 * Spigot's own rails buy from a seller it knows. This buys from anything that
 * speaks x402 on Arc, which is the difference between a closed loop and a market:
 * point it at somebody else's endpoint and the money leaves for an address this
 * project does not control.
 *
 * It is also the quickest way for a seller to test their own integration. Run
 * `npm run seller` in one terminal, point this at it in another, and the whole
 * handshake - quote, sign, verify, deliver, settle - happens in about a second.
 *
 * Needs SPIGOT_ARC_KEY, and the wallet needs a Gateway balance on Arc. Top one
 * up with `npm run topup -- --fund 1`.
 */

import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ARC, arcTxUrl, unitsToUsdc } from "../src/arc";

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run buy -- <url>");
  console.error("Example: npm run buy -- http://localhost:4021/sell?units=30000");
  process.exit(1);
}

const key = process.env.SPIGOT_ARC_KEY;
if (!key) {
  console.error("No Arc key: set SPIGOT_ARC_KEY in .env.local to pay for anything.");
  process.exit(1);
}

const privateKey = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
const gateway = new GatewayClient({ chain: ARC.gatewayChain, privateKey, rpcUrl: ARC.rpc });

console.log(`Buying from ${target}`);
console.log(`  network: ${ARC.name} (chain ${ARC.chainId})`);
console.log(`  payer:   ${gateway.account.address}`);

const before = (await gateway.getBalance()).available;
console.log(`  gateway balance: $${unitsToUsdc(before.toString()).toFixed(6)}\n`);

/**
 * One call does the whole x402 dance: the first request comes back 402 with the
 * seller's terms, the client signs an authorisation for exactly those terms, and
 * the retry carries it. Nothing is signed that the seller did not quote.
 */
const result = await gateway.pay<Record<string, unknown>>(target, { method: "GET" });

const after = (await gateway.getBalance()).available;
const hash = result.transaction ?? "";
const onChain = /^0x[0-9a-fA-F]{64}$/.test(hash);

console.log(`Paid $${unitsToUsdc(result.amount.toString())} USDC`);
console.log(`  settlement:  ${hash || "(none returned)"}`);
if (onChain) console.log(`  explorer:    ${arcTxUrl(hash)}`);
else if (hash) console.log("  note:        a Gateway settlement id, batched on-chain by Circle later");
console.log(`  balance now: $${unitsToUsdc(after.toString()).toFixed(6)}`);
console.log(`\nWhat the seller delivered:\n${JSON.stringify(result.data, null, 2)}`);
