/**
 * Pre-derive the settled history that cannot change.
 *
 *   npm run seed
 *
 * Everything from the first settlement up to a finalised block gives the same
 * answer today, tomorrow and in a year, and re-reading it on every cold instance
 * would cost close to a second of Arc's throttled RPC per 9,000-block window to
 * produce a number nobody could have changed in the meantime.
 *
 * So it is derived once, here, from the first settlement to the head (or to
 * SPIGOT_TO_BLOCK), and checked in. The public feed reads this range from the
 * file and only the blocks after it live. Run it again whenever the feed's note
 * says blocks past its tail went unread. This is not a ledger of our own:
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

async function main(): Promise<void> {
  const head = await headBlock();
  const fromBlock = GENESIS_BLOCK;
  const bound = process.env.SPIGOT_TO_BLOCK ? Number(process.env.SPIGOT_TO_BLOCK) : head;
  const toBlock = Math.min(head, bound);

  console.log("Deriving Spigot's settled history from Arc.\n");
  console.log(`  blocks:  ${fromBlock} to ${toBlock}`);
  console.log(`  windows: ${Math.ceil((toBlock - fromBlock + 1) / BLOCKS_PER_CHUNK)}\n`);

  const scan = await scanSettlements({
    fromBlock,
    toBlock,
    onWindow: (done, total) => {
      if (done === total || done % 50 === 0) console.log(`  scanning window ${done} of ${total}`);
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
