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
 *
 * The agent separates two cadences that naive per-second billing conflates:
 *
 *   - it decides every second, because that is how often the value of the next
 *     second changes;
 *   - it settles on-chain only when the amount owed is large enough that Arc's
 *     fee is a small share of it, because gas is real money too.
 *
 * Arc prices gas in the same USDC the agent is paying with, so that second
 * cadence is not guesswork - it is read off the live fee market (see
 * `src/arc-gas.ts`). Time metered but not yet settled is never lost: the meter
 * only advances once a tick is committed, so it rolls forward and is paid for
 * before the gate shuts.
 */

import { StreamingMeter, type Session, type TickQuote } from "meter402";
import type { SettlementProvider } from "meter402";
import { minEconomicSettlementUnits } from "./arc-gas";

/** What the fee market allows: how often settling on-chain is worth doing. */
export interface SettlementEconomics {
  /** Cost of one on-chain settlement, in USDC smallest units. */
  costUnits: string;
  /** Ceiling on the chain fee as a share of the value each settlement moves. */
  maxOverheadRatio: number;
}

export interface AgentPolicy {
  /** Hard cap on total spend for this stream, in USDC smallest units. */
  budgetUnits: string;
  /** Refuse any stream priced above this, in USDC smallest units per second. */
  maxRatePerSecondUnits: string;
  /** Plain-English goal, recorded on the session for the proof feed. */
  objective: string;
  /**
   * Optional. When set, the agent keeps metering but holds settlement back until
   * the amount owed clears the overhead ceiling. Leave it off and every tick
   * settles immediately, which is the right choice only when the stream's rate
   * per second already dwarfs the chain fee.
   */
  settlement?: SettlementEconomics;
}

export interface TickContext {
  tick: number;
  session: Session;
  quote: TickQuote;
  /** Settled so far this session, in USDC smallest units. */
  spentUnits: bigint;
  /** Cost of this interval alone: what is owed now, minus what was already owed. */
  marginalUnits: bigint;
  /** Metered but not yet settled, in USDC smallest units. */
  accruedUnits: bigint;
}

/**
 * The agent's decision input: the marginal value (in USDC smallest units) it
 * places on the NEXT chunk it would receive by paying this tick. Tie it to a real
 * signal - a data freshness score, a model's confidence, an arbitrage edge. When
 * it falls below what that chunk costs, the agent stops paying.
 */
export type ValueSignal = (ctx: TickContext) => number | Promise<number>;

export interface StreamOptions {
  valueSignal: ValueSignal;
  /** Wall-clock spacing between decisions. */
  tickIntervalMs?: number;
  /** Safety stop so a demo can't run forever. */
  maxTicks?: number;
}

export interface AgentResult {
  session: Session;
  /** On-chain settlements actually made. */
  settlements: number;
  /** Intervals the agent metered and ruled on, settled or not. */
  ticksMetered: number;
  spentUnits: string;
  closedReason: string;
  /** The smallest economical settlement the live fee market implied, if set. */
  minSettlementUnits?: string;
}

interface CloseState {
  pending: TickQuote | null;
  settlements: number;
  ticksMetered: number;
  spent: bigint;
  /**
   * Set once a settlement has failed on-chain. A failed transfer may still be in
   * flight, so the close-out must not retry it and risk paying twice.
   */
  settlementFailed: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Consecutive dead intervals that mean the meter's per-tick cap has been hit. */
const STALL_LIMIT = 2;

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

    const minSettle = this.policy.settlement
      ? minEconomicSettlementUnits(this.policy.settlement.costUnits, this.policy.settlement.maxOverheadRatio)
      : 0n;

    const session = this.meter.openSession(streamId, this.walletId, {
      objective: this.policy.objective,
      policy: `budget=${this.policy.budgetUnits} maxRate/s=${this.policy.maxRatePerSecondUnits}`,
    });

    const state: CloseState = {
      pending: null,
      settlements: 0,
      ticksMetered: 0,
      spent: 0n,
      settlementFailed: false,
    };
    const done = (reason: string) => this.close(session, state, reason, minSettle);

    // Refuse a stream that is priced above the agent's rate ceiling - before a
    // single tick is paid.
    const stream = this.meter.streamOf(session.id);
    if (stream && BigInt(stream.ratePerSecond) > BigInt(this.policy.maxRatePerSecondUnits)) {
      return done("stream rate above ceiling - never opened the gate");
    }

    const budget = BigInt(this.policy.budgetUnits);
    let accrued = 0n;
    let stalled = 0;

    for (let tick = 1; tick <= maxTicks; tick++) {
      await sleep(tickIntervalMs);

      const quote = this.meter.quoteTick(session.id);
      const owed = BigInt(quote.amount);
      const marginal = owed - accrued;

      // No new metered time to rule on. If that keeps happening while something
      // is owed, the meter's per-tick cap has been reached and holding out for a
      // cheaper moment would mean consuming time the provider is never paid for.
      // Settle what is owed instead, and let the cap set the cadence.
      if (marginal <= 0n) {
        if (state.pending && ++stalled >= STALL_LIMIT) {
          const failure = await this.trySettle(state, state.pending);
          if (failure) return done(`settlement failed - ${failure}`);
          accrued = 0n;
          stalled = 0;
        }
        continue;
      }
      stalled = 0;
      state.ticksMetered += 1;

      // Holding this interval must not commit the agent past its own budget.
      if (state.spent + owed > budget) return done("budget exhausted");

      const ctx: TickContext = {
        tick,
        session,
        quote,
        spentUnits: state.spent,
        marginalUnits: marginal,
        accruedUnits: accrued,
      };

      // Is the next chunk still worth what it costs? The autonomous call, made
      // against this interval alone, never against the accrued backlog.
      const value = BigInt(Math.round(await opts.valueSignal(ctx)));
      if (value < marginal) return done("marginal value below tick cost");

      // Worth holding. Is it yet worth a chain fee? Below the economical floor
      // the agent keeps the stream open and lets the amount owed roll forward.
      if (minSettle > 0n && owed < minSettle) {
        accrued = owed;
        state.pending = quote;
        continue;
      }

      const failure = await this.trySettle(state, quote);
      if (failure) return done(`settlement failed - ${failure}`);
      accrued = 0n;
    }

    return done("objective complete");
  }

  /** Pay one quoted tick on Arc and record it against the meter. */
  private async settle(state: CloseState, quote: TickQuote): Promise<void> {
    const result = await this.provider.settle(quote);
    this.meter.commitTick(quote, result);
    state.spent += BigInt(quote.amount);
    state.settlements += 1;
    state.pending = null;
  }

  /**
   * Settle, and turn a failure into a reason rather than an exception. A stream
   * that cannot pay has to shut down deliberately and on the record, not throw and
   * leave a session open. Nothing is counted as spent unless the transfer
   * succeeded, so a failure can never inflate the proof feed.
   */
  private async trySettle(state: CloseState, quote: TickQuote): Promise<string | null> {
    try {
      await this.settle(state, quote);
      return null;
    } catch (err) {
      state.settlementFailed = true;
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async close(
    session: Session,
    state: CloseState,
    reason: string,
    minSettle: bigint,
  ): Promise<AgentResult> {
    // Seconds already held and judged worth paying are settled before the gate
    // shuts, so the provider is never left owed for time it actually delivered.
    // This is affordable by construction: the pending amount passed the budget
    // check on the tick that accrued it, and nothing has been spent since.
    //
    // Unless a settlement has already failed. A failed transfer may still land, so
    // retrying it here could pay the same seconds twice. Better to close owing.
    if (state.pending && !state.settlementFailed) await this.trySettle(state, state.pending);

    const closed = this.meter.closeSession(session.id, reason);
    return {
      session: closed,
      settlements: state.settlements,
      ticksMetered: state.ticksMetered,
      spentUnits: state.spent.toString(),
      closedReason: reason,
      minSettlementUnits: minSettle > 0n ? minSettle.toString() : undefined,
    };
  }
}
