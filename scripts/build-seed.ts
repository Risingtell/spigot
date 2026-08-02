/**
 * Pre-derive the settled history that cannot change.
 *
 *   npm run seed
 *
 * The public feed reads a bounded window of Arc's log index on every request. That
 * window is anchored at the first settlement and covers finalised blocks, so the
 * answer it produces is the same today, tomorrow and in a year. Re-deriving it on
 * every cold instance costs about seventeen seconds of Arc's throttled RPC and
 * produces a number nobody could have changed in the meantime.
 *
 * So it is derived once, here, and checked in. This is not a ledger of our own:
 * the script is committed, the blocks it reads are named in the output, anyone can
 * regenerate it by running this command, and `npm run verify` re-derives the same
 * settlements from genesis to the chain head without reading this file at all. If
 * the seed and the chain ever disagreed, the verifier would say so.
 *
 * The gas-free half is deliberately not seeded. Those settlements live in Circle's
 * Gateway API rather than in a block, so they are fetched live on every request.
 */

import { writeFileSync } from "node:fs";
import { BLOCKS_PER_CHUNK, GENESIS_BLOCK, headBlock, scanSettlements } from "../src/chain";
import { unitsToUsdc } from "../src/arc";

/** Must match the feed's own window, or the seed would cover the wrong range. */
const WINDOWS = 20;

async function main(): Promise<void> {
  const head = await headBlock();
  const fromBlock = GENESIS_BLOCK;
  const toBlock = Math.min(head, fromBlock + WINDOWS * BLOCKS_PER_CHUNK - 1);

  console.log("Deriving Spigot's settled history from Arc.\n");
  console.log(`  blocks:  ${fromBlock} to ${toBlock}`);
  console.log(`  windows: ${WINDOWS}\n`);

  const scan = await scanSettlements({
    fromBlock,
    toBlock,
    onWindow: (done, total) => {
      if (done === total || done % 5 === 0) console.log(`  scanning window ${done} of ${total}`);
    },
  });

  if (scan.missed.length) {
    console.error(`\n${scan.missed.length} window(s) could not be read. A seed with a hole in it is worse`);
    console.error("than no seed, because the feed would publish it as complete. Not writing anything.");
    process.exitCode = 1;
    return;
  }

  const seed = {
    note:
      "Derived from Arc's USDC transfer log by scripts/build-seed.ts over finalised blocks. " +
      "Regenerate with npm run seed. Re-derive independently, from genesis to the chain head " +
      "and without reading this file, with npm run verify.",
    fromBlock: scan.fromBlock,
    toBlock: scan.toBlock,
    windows: scan.windows,
    derivedAt: new Date().toISOString(),
    perProvider: scan.totals.perProvider,
  };

  writeFileSync(new URL("../src/seed.json", import.meta.url), `${JSON.stringify(seed, null, 2)}\n`);

  console.log("\nWrote src/seed.json");
  for (const [label, row] of Object.entries(scan.totals.perProvider)) {
    console.log(`  ${label.padEnd(24)} ${row.count} transfer(s), $${unitsToUsdc(row.total).toFixed(6)}`);
  }
}

await main();
