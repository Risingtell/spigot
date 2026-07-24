/**
 * StreamingAgent - an autonomous buyer that streams a metered resource on Arc and
 * governs its own spend.
 *
 * This is the "real agent autonomy" the Agentic Economy track asks for: not an AI
 * wrapper around a checkout, but an agent that, every tick, weighs the marginal
 * value of the next chunk against what that chunk costs and against its own
 * budget and rate ceiling - and closes its own gate, on its own, the moment the
 * next second stops being worth paying for. Every "keep paying" is a real USDC
 * settlement on Arc; every "stop" is a recorded decision with a reason.
 */

import { StreamingMeter, type Session, type TickQuote } from "meter402";
import type { SettlementProvider } from "meter402";

export interface AgentPolicy {
  /** Hard cap on total spend for this stream, in USDC smallest units. */
  budgetUnits: string;
  /** Refuse any stream priced above this, in USDC smallest units per second. */
  maxRatePerSecondUnits: string;
  /** Plain-English goal, recorded on the session for the proof feed. */
  objective: string;
}

export interface TickContext {
  tick: number;
  session: Session;
  quote: TickQuote;
  spentUnits: bigint;
}

/**
 * The agent's decision input: the marginal value (in USDC smallest units) it
 * places on the NEXT chunk it would receive by paying this tick. Tie it to a real
 * signal - a data freshness score, a model's confidence, an arbitrage edge. When
 * it falls below the tick's cost, the agent stops paying.
 */
export type ValueSignal = (ctx: TickContext) => number | Promise<number>;

export interface StreamOptions {
  valueSignal: ValueSignal;
  /** Wall-clock spacing between ticks. */
  tickIntervalMs?: number;
  /** Safety stop so a demo can't run forever. */
  maxTicks?: number;
}

export interface AgentResult {
  session: Session;
  ticksPaid: number;
  spentUnits: string;
  closedReason: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StreamingAgent {
  constructor(
    private readonly meter: StreamingMeter,
    private readonly provider: SettlementProvider,
    /** The agent's own wallet (Circle wallet id on Arc, or a label in mock mode). */
    private readonly walletId: string,
    private readonly policy: AgentPolicy,
  ) {}

  async stream(streamId: string, opts: StreamOptions): Promise<AgentResult> {
    const tickIntervalMs = opts.tickIntervalMs ?? 1000;
    const maxTicks = opts.maxTicks ?? 3600;

    const session = this.meter.openSession(streamId, this.walletId, {
      objective: this.policy.objective,
      policy: `budget=${this.policy.budgetUnits} maxRate/s=${this.policy.maxRatePerSecondUnits}`,
    });

    // Refuse a stream that is priced above the agent's rate ceiling - before a
    // single tick is paid.
    const stream = this.meter.streamOf(session.id);
    if (stream && BigInt(stream.ratePerSecond) > BigInt(this.policy.maxRatePerSecondUnits)) {
      return this.close(session, 0, 0n, "stream rate above ceiling - never opened the gate");
    }

    const budget = BigInt(this.policy.budgetUnits);
    let spent = 0n;
    let ticksPaid = 0;

    for (let tick = 1; tick <= maxTicks; tick++) {
      await sleep(tickIntervalMs);

      const quote = this.meter.quoteTick(session.id);
      const cost = BigInt(quote.amount);
      const ctx: TickContext = { tick, session, quote, spentUnits: spent };

      // Would this tick blow the budget? Stop.
      if (spent + cost > budget) {
        return this.close(session, ticksPaid, spent, "budget exhausted");
      }

      // Is the next chunk still worth what it costs? The autonomous call.
      const value = BigInt(Math.round(await opts.valueSignal(ctx)));
      if (value < cost) {
        return this.close(session, ticksPaid, spent, "marginal value below tick cost");
      }

      // Worth it - settle one real tick on Arc, then commit it to the meter.
      const result = await this.provider.settle(quote);
      this.meter.commitTick(quote, result);
      spent += cost;
      ticksPaid += 1;
    }

    return this.close(session, ticksPaid, spent, "objective complete");
  }

  private close(session: Session, ticksPaid: number, spent: bigint, reason: string): AgentResult {
    const closed = this.meter.closeSession(session.id, reason);
    return { session: closed, ticksPaid, spentUnits: spent.toString(), closedReason: reason };
  }
}
