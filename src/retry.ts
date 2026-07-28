/**
 * Backing off a public RPC.
 *
 * Arc's public endpoint throttles bursts, and both of Spigot's read paths found
 * that the hard way: the verifier died on a 429 partway through a log scan, and
 * the Gateway client died on two balance reads issued back to back. Neither was a
 * logic error. A public endpoint is a shared resource and the right response to
 * being throttled is to wait, not to fail the run.
 */

/**
 * Errors worth waiting out rather than surfacing.
 *
 * The phrasing matters more than it should. Arc's public RPC answers an overrun
 * with "request limit reached", which matches none of the obvious rate-limit
 * wordings, so a first pass at this let the throttle straight through and failed
 * the run. Match on the message text of the whole error chain, since viem wraps
 * the cause several layers deep.
 */
function isTransient(err: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 6; depth++) {
    if (current instanceof Error) {
      parts.push(current.message, current.name);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const text = parts.join(" ");
  return /429|rate.?limit|request limit|limit reached|too many requests|throttl|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|fetch failed|50[0-9]\b|service unavailable|temporarily unavailable/i.test(
    text,
  );
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Retry anything, not just errors that look transient. */
  retryAll?: boolean;
  label?: string;
}

/**
 * Run `fn`, retrying transient failures with exponential backoff and jitter.
 * A permanent error (a revert, a bad argument) is rethrown on the first attempt
 * so real bugs stay loud.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 400;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const worthRetrying = opts.retryAll || isTransient(err);
      if (!worthRetrying || attempt >= attempts) throw err;
      const delay = base * 2 ** (attempt - 1) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
