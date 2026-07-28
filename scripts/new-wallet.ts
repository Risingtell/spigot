/**
 * Generate the two Arc addresses Spigot needs, and write the keys somewhere they
 * will not leak.
 *
 *   npm run wallet:new
 *
 * The agent wallet signs and pays. The provider address only receives. Both keys
 * are appended to .env.local, which is gitignored; only the public addresses are
 * printed, so a key never reaches a terminal transcript, a screenshot or a chat.
 *
 * Fund the agent address at https://faucet.circle.com (Arc Testnet, USDC), then
 * `npm run agent` settles for real.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_RPC, ARC_EXPLORER } from "../src/arc";

const ENV_PATH = resolve(process.cwd(), ".env.local");

function newKey(): { key: `0x${string}`; address: string } {
  const key = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  return { key, address: privateKeyToAccount(key).address };
}

function alreadySet(name: string): boolean {
  if (!existsSync(ENV_PATH)) return false;
  return new RegExp(`^${name}=.+$`, "m").test(readFileSync(ENV_PATH, "utf8"));
}

if (alreadySet("SPIGOT_ARC_KEY")) {
  console.error("SPIGOT_ARC_KEY is already set in .env.local.");
  console.error("Refusing to overwrite it. Remove the line by hand first if you really want a new agent wallet.");
  process.exitCode = 1;
} else {
  const agent = newKey();
  const provider = newKey();

  appendFileSync(
    ENV_PATH,
    [
      "",
      `# Generated ${new Date().toISOString()} by npm run wallet:new`,
      `SPIGOT_ARC_KEY=${agent.key}`,
      `SPIGOT_AGENT_ADDRESS=${agent.address}`,
      `SPIGOT_PROVIDER_ADDRESS=${provider.address}`,
      `SPIGOT_PROVIDER_KEY=${provider.key}`,
      "",
    ].join("\n"),
    "utf8",
  );

  console.log("Two Arc Testnet addresses generated. Keys are in .env.local, which git ignores.\n");
  console.log("  AGENT (fund this one, it signs and pays)");
  console.log(`    ${agent.address}`);
  console.log(`    ${ARC_EXPLORER}/address/${agent.address}\n`);
  console.log("  PROVIDER (receives settlement, needs no funding)");
  console.log(`    ${provider.address}\n`);
  console.log("Next:");
  console.log("  1. Fund the AGENT address with USDC at https://faucet.circle.com (network: Arc Testnet)");
  console.log("  2. npm run agent          settles for real against " + ARC_TESTNET_RPC);
  console.log("  3. npm run verify         re-derives every settlement from the chain");
  console.log("\nNever paste the contents of .env.local anywhere.");
}
