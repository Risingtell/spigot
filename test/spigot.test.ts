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
import {
  ACTIVE_MARKET_TRADES_PER_SECOND,
  MIN_MEANINGFUL_TRADES_PER_SECOND,
  activityTarget,
  blockValueUnits,
} from "../src/market";
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

/**
 * The invariant that makes the overhead ceiling mean something: it has to hold on
 * every settlement, not just the convenient ones. Each case below ends the stream a
 * different way - value collapse, budget, running out of ticks - and none of them is
 * allowed to leave a sub-floor fragment on the chain.
 */
for (const c of [
  { name: "the stream stops being worth its price", stopAt: 4, budget: "600000", ticks: 14 },
  { name: "the budget runs out", stopAt: Infinity, budget: "70000", ticks: 20 },
  { name: "the run ends mid-block", stopAt: Infinity, budget: "600000", ticks: 5 },
]) {
  test(`every settlement clears the economical floor when ${c.name}`, async () => {
    const { meter, provider } = harness({ ratePerSecond: "50000" });
    const agent = new StreamingAgent(meter, provider, "agent", {
      budgetUnits: c.budget,
      maxRatePerSecondUnits: "100000",
      objective: "test",
      settlement: { costUnits: "1564", maxOverheadRatio: 0.05, meterMaxTickSeconds: 60 },
    });

    const result = await agent.stream("stream", {
      valueSignal: (ctx: TickContext) => (ctx.tick >= c.stopAt ? 0 : Number(ctx.marginalUnits) * 4),
      tickIntervalMs: 100,
      maxTicks: c.ticks,
    });

    const floor = minEconomicSettlementUnits("1564", 0.05);
    assert.ok(result.settlements > 0, "the provider should have been paid");

    /**
     * Every settlement clears the floor, with one bounded exception that is real
     * and worth stating rather than asserting away.
     *
     * A tick can overshoot the floor: the meter bills elapsed time, and if the
     * process is descheduled the interval that was meant to land just above the
     * floor lands well above it. If that overshoot no longer fits the budget, the
     * agent is left holding metered time it cannot settle at the floor. Three
     * things then conflict, and only one of them can give. Breaching the budget is
     * not an option, and leaving a provider unpaid for time it delivered is not an
     * option, so the last settlement of a budget-exhausted session may fall below
     * the floor. It is bounded by what one block had already metered, and it can
     * only ever be the final one.
     */
    const paid = provider.paid.map((a) => BigInt(a));
    const belowFloor = paid.filter((a) => a < floor);

    for (const amount of paid.slice(0, -1)) {
      assert.ok(
        amount >= floor,
        `settlement ${amount} is below the floor ${floor} and is not the last (closed: ${result.closedReason})`,
      );
      // Which is the same thing as saying the chain fee stayed inside the ceiling.
      assert.ok(overheadRatio("1564", amount.toString()) <= 0.05);
    }

    if (belowFloor.length > 0) {
      assert.equal(belowFloor.length, 1, "at most one settlement may fall below the floor");
      assert.equal(paid[paid.length - 1], belowFloor[0], "and it must be the last one");
      assert.match(
        result.closedReason,
        /budget/,
        "a sub-floor settlement is only ever forced by the budget running out",
      );
      assert.ok(belowFloor[0] > 0n, "and it still has to be worth paying");
    }

    assert.equal(provider.total().toString(), result.spentUnits);
  });
}

test("a stream too cheap to settle inside one meter tick is rejected outright", async () => {
  // $0.001/sec needs about 31s of stream to be worth settling. A meter that caps a
  // tick at 10s could never measure that, so this is a setup error, not a runtime
  // surprise to be discovered halfway through someone's money.
  const { meter, provider } = harness({ ratePerSecond: "1000", maxTickSeconds: 10 });
  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    objective: "test",
    settlement: { costUnits: "1564", maxOverheadRatio: 0.05, meterMaxTickSeconds: 10 },
  });

  await assert.rejects(
    () => agent.stream("stream", { valueSignal: () => 1e9, tickIntervalMs: 50, maxTicks: 3 }),
    /caps a tick at 10s/,
  );
  assert.equal(provider.paid.length, 0);
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

test("a budget too small for one block never opens the gate", async () => {
  // An overhead ceiling this tight puts the smallest worthwhile settlement above the
  // whole budget. The agent will not consume time it cannot pay for, so it declines
  // before anything is delivered rather than running up a debt it must default on.
  const { meter, provider } = harness({ ratePerSecond: "50000" });
  const agent = new StreamingAgent(meter, provider, "agent", {
    budgetUnits: "600000",
    maxRatePerSecondUnits: "100000",
    objective: "test",
    settlement: { costUnits: "1564", maxOverheadRatio: 0.0005 },
  });

  const result = await agent.stream("stream", {
    valueSignal: (ctx: TickContext) => Number(ctx.marginalUnits) * 2,
    tickIntervalMs: 60,
    maxTicks: 6,
  });

  assert.equal(result.closedReason, "budget below the smallest settlement worth making");
  assert.equal(result.settlements, 0);
  assert.equal(result.spentUnits, "0");
  assert.equal(provider.paid.length, 0);
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

test("a top-up asks for the shortfall to the target, not the shortfall to the floor", () => {
  // The distinction matters: refilling only to the floor would leave the agent one
  // settlement away from being below it again, and topping up costs a Gateway fee
  // each time. It refills to the target so the next draw is far away.
  const policy = treasuryPolicy({ floorUsdc: 5, targetUsdc: 20, reserveChain: "Base_Sepolia" });
  const plan = planTopUp(usdcToUnits(4.9), policy);
  assert.equal(plan.needed, true);
  assert.equal(plan.amountUsdc, "15.100000");
  assert.ok(Number(plan.amountUsdc) > 20 - 5 - 0.2, "should refill to the target, not just clear the floor");
});

test("a balance exactly at the floor is not topped up", () => {
  // The floor is the point at which a top-up becomes necessary, not the point at
  // which it becomes overdue, so the comparison has to be inclusive or the agent
  // would draw on itself one settlement early, every time.
  const policy = treasuryPolicy({ floorUsdc: 5, targetUsdc: 20, reserveChain: "Base_Sepolia" });
  assert.equal(planTopUp(usdcToUnits(5), policy).needed, false);
  assert.equal(planTopUp(usdcToUnits(4.999999), policy).needed, true);
});

// ---------------------------------------------------------------------------
// The value signal's own calibration
// ---------------------------------------------------------------------------

test("the activity bar is what the market was doing, not a number from July", () => {
  // A fixed absolute threshold was the original design and it was wrong: the same
  // feed measured 2 to 10 trades/sec when it was calibrated and about 0.7 later,
  // so a hardcoded 6 would refuse the feed in any ordinary quiet hour. The bar is
  // now whatever the agent measured before it opened the gate.
  assert.equal(activityTarget(3), 3);
  assert.equal(activityTarget(0.7), 0.7);
});

test("a dead market cannot set itself a bar of zero and then clear it", () => {
  // Without a floor, a relative measure argues that no trades against a baseline
  // of no trades is the market performing exactly as promised.
  assert.equal(activityTarget(0), MIN_MEANINGFUL_TRADES_PER_SECOND);
  assert.ok(blockValueUnits({ tradesPerSecond: 0, costUnits: 50_000n, fullValueTps: activityTarget(0) }) === 0);
});

test("a frantic opening minute cannot set a bar the session then fails", () => {
  // Capped at the busy-market reference, so an unrepresentative burst at the
  // moment the gate opens does not make everything after it look like a lull.
  assert.equal(activityTarget(500), ACTIVE_MARKET_TRADES_PER_SECOND);
});

test("a block is worth paying for while flow holds up, and not once it falls away", () => {
  const bar = activityTarget(4);
  const cost = 50_000n;
  // Holding at the bar: worth more than it costs, so the agent keeps buying.
  assert.ok(blockValueUnits({ tradesPerSecond: 4, costUnits: cost, fullValueTps: bar }) > Number(cost));
  // Flow halves: worth less than it costs, so the gate closes.
  assert.ok(blockValueUnits({ tradesPerSecond: 2, costUnits: cost, fullValueTps: bar }) < Number(cost));
});

// ---------------------------------------------------------------------------
// Unified balance
// ---------------------------------------------------------------------------

test("the unified balance is the sum of every chain, and the policy reads that one number", () => {
  // The whole point of the rewrite: a budget spread over several chains is not one
  // budget. Whatever the per-chain split, the agent's spendable total is the sum,
  // and it is that total a plan has to be made against.
  const perChain = [
    { chain: "Arc_Testnet", units: "1600350" },
    { chain: "Base_Sepolia", units: "8000000" },
    { chain: "Optimism_Sepolia", units: "400000" },
  ];
  const total = perChain.reduce((sum, row) => sum + BigInt(row.units), 0n);
  assert.equal(total.toString(), "10000350");
  assert.equal(unitsToUsdc(total.toString()), 10.00035);

  // No single chain could fund this draw; the unified balance can, which is
  // exactly the case a per-chain reserve gets wrong.
  const policy = treasuryPolicy({ floorUsdc: 5, targetUsdc: 10, reserveChain: "Base_Sepolia" });
  const plan = planTopUp(usdcToUnits(1), policy);
  assert.equal(plan.amountUsdc, "9.000000");
  assert.ok(
    BigInt(usdcToUnits(Number(plan.amountUsdc))) <= total,
    "the draw must be fundable from the unified balance even though no one chain holds it",
  );
  assert.ok(perChain.every((row) => BigInt(row.units) < BigInt(usdcToUnits(Number(plan.amountUsdc)))));
});
