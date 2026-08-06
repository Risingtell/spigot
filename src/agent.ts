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
 * Arc prices gas in the same USDC the agent is paying with, so that second cadence
 * is not guesswork - it is read off the live fee market (see `src/arc-gas.ts`).
 *
 * The amount worth settling is therefore also the smallest block of time worth
 * opening, and the agent treats it that way: opening a block commits it to paying
 * for the whole block, and it only opens one it can pay for outright. So it always
 * stops on a block boundary. If the stream stops being worth its price partway
 * through a block, the agent stops buying immediately and rides out what it already
 * committed to, rather than walking away from time the provider delivered. Every
 * settlement it makes is one whole block, which is what keeps the chain fee inside
 * the ceiling on all of them, including the last.
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
  /**
   * The meter's `maxTickSeconds`. Supplying it lets the agent reject a stream too
   * cheap to reach an economical settlement inside one tick, instead of quietly
   * consuming time the meter has stopped counting.
   */
  meterMaxTickSeconds?: number;
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

    // A settlement is only worth making at the economical floor, so that floor is
    // also the smallest block of time worth opening. The agent must be able to
    // reach it inside one meter tick, or it would keep consuming time the meter has
    // stopped counting. Catch that as a configuration error rather than let it
    // become a silent underpayment.
    if (minSettle > 0n && stream && this.policy.settlement?.meterMaxTickSeconds) {
      const rate = BigInt(stream.ratePerSecond);
      const needed = rate > 0n ? Number(minSettle) / Number(rate) : 0;
      if (needed > this.policy.settlement.meterMaxTickSeconds) {
        throw new Error(
          `A settlement worth making on this stream covers ${needed.toFixed(1)}s, but the meter caps a tick at ` +
            `${this.policy.settlement.meterMaxTickSeconds}s. Raise maxTickSeconds or price the stream higher.`,
        );
      }
    }

    const budget = BigInt(this.policy.budgetUnits);
    let accrued = 0n;
    let stalled = 0;
    // Set once the agent has decided not to open another block, along with why. It
    // still owes the block it is in, so it rides that one out and stops on the
    // boundary rather than leaving a fragment behind.
    let closeReason: string | null = null;

    // The tick limit stops the agent opening new blocks. Finishing the block it
    // already committed to may take a few ticks more, so the loop is allowed to run
    // past the limit for that, and no further.
    const hardCap = maxTicks * 3 + 10;

    for (let tick = 1; tick <= hardCap; tick++) {
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
          // Same boundary as the normal settle path: a block just closed, so a
          // pending stop decision takes effect now rather than opening another one.
          if (closeReason !== null) return done(closeReason);
        }
        continue;
      }
      stalled = 0;

      // Out of ticks: stop opening blocks. On a boundary that is the end of the run,
      // and this interval is never ruled on, so it is not counted either.
      if (tick > maxTicks && closeReason === null) {
        if (accrued === 0n) return done("objective complete");
        closeReason = "objective complete";
      }

      state.ticksMetered += 1;

      // Opening a block commits the agent to the whole block, so it only opens one
      // it can pay for outright. Mid-block, only what is actually owed matters.
      const commitment = accrued === 0n && minSettle > owed ? minSettle : owed;
      if (state.spent + commitment > budget) {
        // Nothing has been settled and the agent cannot even fund one block: the
        // budget was never enough for this stream, which is worth saying plainly.
        const affordable = state.spent > 0n || commitment === owed;
        return done(affordable ? "budget exhausted" : "budget below the smallest settlement worth making");
      }

      const ctx: TickContext = {
        tick,
        session,
        quote,
        spentUnits: state.spent,
        marginalUnits: marginal,
        accruedUnits: accrued,
      };

      // Is the next slice still worth what it costs? The autonomous call, made
      // against this interval alone, never against the accrued backlog. Once the
      // answer is no the agent has decided; it does not keep asking.
      if (closeReason === null) {
        const value = BigInt(Math.round(await opts.valueSignal(ctx)));
        if (value < marginal) closeReason = "marginal value below tick cost";
      }

      // Not yet a block worth settling. Keep the stream open and let what is owed
      // roll forward, whether the agent is still buying or riding out its
      // commitment. Nothing is lost: the meter has not advanced.
      if (owed < minSettle) {
        accrued = owed;
        state.pending = quote;
        continue;
      }

      const failure = await this.trySettle(state, quote);
      if (failure) return done(`settlement failed - ${failure}`);
      accrued = 0n;

      // A full block, paid for, on a clean boundary. If the agent stopped wanting
      // the stream partway through it, this is where it lets go.
      if (closeReason !== null) return done(closeReason);
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
