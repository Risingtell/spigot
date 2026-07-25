/**
 * Tests over the rules that decide money movement.
 *
 *   npm test
 *
 * Everything here runs offline against a fake settlement provider, because the
 * point is the decision logic: what the agent owes, when it is worth settling,
 * whether a budget can be breached, and whether the provider can ever be left
 * holding delivered time that was never paid for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, StreamingMeter, type SettlementProvider, type TickQuote } from "meter402";
import { StreamingAgent, type TickContext } from "../src/agent";
import { USDC_UNIT, unitsToUsdc, usdcToUnits, weiToUnits } from "../src/arc";
import { minEconomicSettlementUnits, overheadRatio, settlementCostFrom } from "../src/arc-gas";
import { planTopUp, treasuryPolicy } from "../src/treasury";

/** Records what it was asked to settle, so tests can assert on money moved. */
class RecordingProvider implements SettlementProvider {
  readonly network = "test";
  readonly mock = true;
  readonly paid: string[] = [];

  async settle(quote: TickQuote) {
    this.paid.push(quote.amount);
    return { txHash: `0xtest${this.paid.length}`, explorerUrl: "", network: this.network };
  }

  total(): bigint {
    return this.paid.reduce((sum, a) => sum + BigInt(a), 0n);
  }
}

function harness(opts: { ratePerSecond: string; maxTickSeconds?: number }) {
  const store = new MemoryStore([
    {
      id: "stream",
      title: "Test stream",
      ratePerSecond: opts.ratePerSecond,
      asset: "USDC",
      provider: "TestProvider",
      payTo: "0xProvider",
    },
  ]);
  const meter = new StreamingMeter(store, {
    payTo: "0xProvider",
    maxTickSeconds: opts.maxTickSeconds ?? 60,
    network: "test",
  });
  return { meter, provider: new RecordingProvider() };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

test("native wei converts into USDC billing units and rounds up", () => {
  // Arc's native view is 18 decimals, the ERC-20 billing view is 6.
  assert.equal(weiToUnits(1_000_000_000_000n), 1n);
  assert.equal(weiToUnits(0n), 0n);
  // A part-unit fee must never round down to zero, or gas would look free.
  assert.equal(weiToUnits(1n), 1n);
  assert.equal(weiToUnits(1_500_000_000_000n), 2n);
});

test("USDC conversions round-trip", () => {
  assert.equal(usdcToUnits(0.05), "50000");
  assert.equal(unitsToUsdc("50000"), 0.05);
  assert.equal(unitsToUsdc(String(USDC_UNIT)), 1);
});

// ---------------------------------------------------------------------------
// Settlement economics
// ---------------------------------------------------------------------------

test("a settlement is priced from gas price times gas used", () => {
  // 20 gwei * 65,000 gas = 1.3e15 wei = 1,300 billing units = $0.0013.
  const cost = settlementCostFrom(20_000_000_000n, 65_000n);
  assert.equal(cost.costUnits, "1300");
  assert.equal(cost.costUsd, 0.0013);
  assert.equal(cost.gasPriceGwei, 20);
  assert.equal(cost.source, "live");
});

test("the economical floor keeps the chain fee inside the ceiling", () => {
  const floor = minEconomicSettlementUnits("1300", 0.05);
  assert.equal(floor, 26_000n); // $0.026, of which $0.0013 is 5%
  assert.ok(overheadRatio("1300", floor.toString()) <= 0.05);
});

test("a ceiling of 100% or more disables holding back", () => {
  assert.equal(minEconomicSettlementUnits("1300", 1), 0n);
});

test("a ceiling of zero is rejected rather than dividing by zero", () => {
  assert.throws(() => minEconomicSettlementUnits("1300", 0), /greater than zero/);
});

// ---------------------------------------------------------------------------
// Agent behaviour
// ---------------------------------------------------------------------------

test("the agent settles fewer times than it meters, without losing time", async () => {
  const { meter, provider } = harness({ ratePerSecond: "50000" }); // $0.05/sec
  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    objective: "test",
    settlement: { costUnits: "1564", maxOverheadRatio: 0.05 }, // floor $0.03128
  });

  const result = await agent.stream("stream", {
    valueSignal: (ctx: TickContext) => Number(ctx.marginalUnits) * 2, // always worth it
    tickIntervalMs: 100,
    maxTicks: 12,
  });

  assert.ok(result.settlements >= 1, "the agent should have settled at least once");
  assert.ok(
    result.settlements < result.ticksMetered,
    `expected batching: ${result.settlements} settlements over ${result.ticksMetered} intervals`,
  );
  // Nothing is billed twice and nothing is dropped: what the provider was paid is
  // exactly what the session reports.
  assert.equal(provider.total().toString(), result.spentUnits);
  assert.equal(result.session.totalPaid, result.spentUnits);
});

test("every settlement except the closing one clears the economical floor", async () => {
  const { meter, provider } = harness({ ratePerSecond: "50000" });
  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    objective: "test",
    settlement: { costUnits: "1564", maxOverheadRatio: 0.05 },
  });

  const result = await agent.stream("stream", {
    valueSignal: (ctx: TickContext) => Number(ctx.marginalUnits) * 2,
    tickIntervalMs: 100,
    maxTicks: 12,
  });

  const floor = minEconomicSettlementUnits("1564", 0.05);
  const scheduled = provider.paid.slice(0, -1);
  for (const amount of scheduled) {
    assert.ok(BigInt(amount) >= floor, `scheduled settlement ${amount} is below the floor ${floor}`);
  }
  assert.ok(result.settlements > 0);
});

test("the agent stops itself when the next slice is not worth its price", async () => {
  const { meter, provider } = harness({ ratePerSecond: "50000" });
  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    objective: "test",
    settlement: { costUnits: "1564", maxOverheadRatio: 0.05 },
  });

  const result = await agent.stream("stream", {
    valueSignal: (ctx: TickContext) => (ctx.tick >= 4 ? 0 : Number(ctx.marginalUnits) * 2),
    tickIntervalMs: 100,
    maxTicks: 20,
  });

  assert.equal(result.closedReason, "marginal value below tick cost");
  assert.equal(result.session.status, "closed");
});

test("time held before an early stop is still paid for", async () => {
  const { meter, provider } = harness({ ratePerSecond: "50000" });
  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    objective: "test",
    // A floor high enough that no scheduled settlement can be reached in the run,
    // so the only way the provider gets paid is the close-out settlement.
    settlement: { costUnits: "1564", maxOverheadRatio: 0.0005 },
  });

  const result = await agent.stream("stream", {
    valueSignal: (ctx: TickContext) => (ctx.tick >= 3 ? 0 : Number(ctx.marginalUnits) * 2),
    tickIntervalMs: 100,
    maxTicks: 10,
  });

  assert.equal(result.settlements, 1, "the accrued remainder should be settled on close");
  assert.ok(BigInt(result.spentUnits) > 0n, "the provider must not be left unpaid for delivered time");
  assert.equal(provider.total().toString(), result.spentUnits);
});

test("the budget is never exceeded", async () => {
  const budget = 40_000n; // $0.04
  const { meter, provider } = harness({ ratePerSecond: "50000" });
  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: budget.toString(),
    maxRatePerSecondUnits: "100000",
    objective: "test",
    settlement: { costUnits: "1564", maxOverheadRatio: 0.05 },
  });

  const result = await agent.stream("stream", {
    valueSignal: (ctx: TickContext) => Number(ctx.marginalUnits) * 10, // always worth it
    tickIntervalMs: 100,
    maxTicks: 30,
  });

  assert.equal(result.closedReason, "budget exhausted");
  assert.ok(
    BigInt(result.spentUnits) <= budget,
    `spent ${result.spentUnits} exceeds the ${budget} budget`,
  );
  assert.ok(provider.total() <= budget);
});

test("a failed settlement closes the stream on the record instead of throwing", async () => {
  const { meter } = harness({ ratePerSecond: "50000" });
  class FailingProvider implements SettlementProvider {
    readonly network = "test";
    readonly mock = true;
    calls = 0;
    async settle(_quote: TickQuote): Promise<never> {
      this.calls += 1;
      throw new Error("no USDC in the agent wallet");
    }
  }
  const provider = new FailingProvider();

  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    objective: "test",
  });

  const result = await agent.stream("stream", {
    valueSignal: (ctx: TickContext) => Number(ctx.marginalUnits) * 2,
    tickIntervalMs: 100,
    maxTicks: 6,
  });

  assert.match(result.closedReason, /settlement failed - no USDC/);
  assert.equal(result.session.status, "closed");
  // Nothing is booked as spent, and the failing transfer is not retried on close.
  assert.equal(result.spentUnits, "0");
  assert.equal(result.settlements, 0);
  assert.equal(provider.calls, 1);
});

test("a stream priced above the rate ceiling is refused before any money moves", async () => {
  const { meter, provider } = harness({ ratePerSecond: "200000" }); // $0.20/sec
  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000", // $0.10/sec ceiling
    objective: "test",
  });

  const result = await agent.stream("stream", {
    valueSignal: () => Number.MAX_SAFE_INTEGER,
    tickIntervalMs: 50,
    maxTicks: 5,
  });

  assert.match(result.closedReason, /above ceiling/);
  assert.equal(result.settlements, 0);
  assert.equal(result.spentUnits, "0");
  assert.equal(provider.paid.length, 0);
});

test("without settlement economics every metered interval settles immediately", async () => {
  const { meter, provider } = harness({ ratePerSecond: "50000" });
  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    objective: "test",
  });

  const result = await agent.stream("stream", {
    valueSignal: (ctx: TickContext) => Number(ctx.marginalUnits) * 2,
    tickIntervalMs: 100,
    maxTicks: 5,
  });

  assert.equal(result.settlements, result.ticksMetered);
});

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------

test("a healthy balance is left alone", () => {
  const policy = treasuryPolicy({ floorUsdc: 0.5, targetUsdc: 2, reserveChain: "Base_Sepolia" });
  const plan = planTopUp(usdcToUnits(1.2), policy);
  assert.equal(plan.needed, false);
  assert.equal(plan.amountUsdc, "");
});

test("a balance under the floor is topped back up to the target", () => {
  const policy = treasuryPolicy({ floorUsdc: 0.5, targetUsdc: 2, reserveChain: "Base_Sepolia" });
  const plan = planTopUp(usdcToUnits(0.25), policy);
  assert.equal(plan.needed, true);
  assert.equal(plan.amountUsdc, "1.750000");
});

test("an empty wallet asks for the full target", () => {
  const policy = treasuryPolicy({ floorUsdc: 0.5, targetUsdc: 2, reserveChain: "Base_Sepolia" });
  assert.equal(planTopUp("0", policy).amountUsdc, "2.000000");
});

test("a target at or below the floor is rejected", () => {
  assert.throws(
    () => planTopUp("0", { floorUnits: "500000", targetUnits: "500000", reserveChain: "Base_Sepolia" }),
    /above the floor/,
  );
});
