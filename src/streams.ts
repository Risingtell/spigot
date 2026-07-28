/**
 * The catalogue of metered streams a provider offers, and what a paid block of
 * each one actually delivers.
 *
 * Keeping this in one place means the seller endpoint, the live runner and the
 * console all price and describe the same thing, and that a stream's content is
 * produced by real work rather than described in prose.
 */

import { MarketWindow, fetchTicker } from "./market";

export interface MeteredStream {
  id: string;
  title: string;
  provider: string;
  /** Price per second, in USDC smallest units. */
  ratePerSecond: string;
  description: string;
  /** Produce the next chunk. Called once per paid block. */
  next(): Promise<unknown>;
}

/**
 * Shared window for the BTC feed. In a serverless deployment this is per
 * instance and short-lived, which is fine: the chunk carries the window it was
 * computed from, so a buyer can always see what it paid for.
 */
const btcWindow = new MarketWindow(24);

const btcRiskFeed: MeteredStream = {
  id: "btc-risk-feed",
  title: "BTC liquidation-risk feed",
  provider: "RiskLabs",
  ratePerSecond: "50000", // $0.05/sec
  description: "Live BTC trade flow, price and spread over a rolling window. Worth holding while the market is trading.",
  async next() {
    const sample = await fetchTicker();
    btcWindow.add(sample);
    const snap = btcWindow.snapshot();
    return {
      asset: "BTC-USD",
      source: "coinbase exchange ticker",
      price: sample.price,
      bid: sample.bid,
      ask: sample.ask,
      tradesPerSecond: snap.tradesPerSecond,
      movementBps: snap.movementBps,
      spreadBps: snap.spreadBps,
      windowSamples: snap.samples,
      observedAt: new Date(sample.at).toISOString(),
    };
  },
};

export const STREAMS: MeteredStream[] = [btcRiskFeed];

export function streamById(id: string): MeteredStream | undefined {
  return STREAMS.find((s) => s.id === id);
}

/** Adapter used by the seller endpoint. */
export function chunkFor(id: string): { title: string; next: () => Promise<unknown> } | null {
  const stream = streamById(id);
  if (!stream) return null;
  return { title: stream.title, next: () => stream.next() };
}
