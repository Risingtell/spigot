/**
 * A pacing proxy in front of Arc's public RPC.
 *
 * Arc's public endpoint does not just cap request volume, it caps concurrency,
 * and hard. Measured against rpc.testnet.arc.network: three simultaneous
 * eth_calls reliably lose one to "request limit reached", six lose one, twelve
 * lose three. Sequentially the same calls all succeed.
 *
 * That matters because SDKs fan out. Circle's GatewayClient issues several reads
 * at once while preparing a deposit, so it trips the limit on a wallet that is
 * funded and an endpoint that is healthy, and the failure surfaces as a contract
 * error rather than as throttling. Retrying does not help, because the problem is
 * how many calls are in flight, not how many have been made.
 *
 * The SDK only accepts an RPC URL, not a transport, so the pacing has to live
 * behind a URL. This is that: a local JSON-RPC forwarder that serialises requests,
 * leaves a small gap between them, and retries upstream throttling itself. Point
 * any client at `proxy.url` and it behaves.
 */

import { createServer, type Server } from "node:http";
import { ARC_TESTNET_RPC } from "./arc";

export interface RpcProxyOptions {
  upstream?: string;
  /** How many upstream requests may be in flight. Two is already risky. */
  concurrency?: number;
  /** Minimum gap between upstream requests. */
  minGapMs?: number;
  attempts?: number;
}

export interface RpcProxy {
  url: string;
  stats(): { forwarded: number; retried: number; failed: number };
  close(): Promise<void>;
}

const THROTTLED = /request limit|rate.?limit|too many requests|limit reached|429/i;

export async function startRpcProxy(opts: RpcProxyOptions = {}): Promise<RpcProxy> {
  const upstream = opts.upstream ?? ARC_TESTNET_RPC;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const minGapMs = opts.minGapMs ?? 90;
  const attempts = opts.attempts ?? 6;

  let forwarded = 0;
  let retried = 0;
  let failed = 0;

  let active = 0;
  let lastStart = 0;
  const waiting: (() => void)[] = [];

  const acquire = async (): Promise<void> => {
    if (active >= concurrency) await new Promise<void>((r) => waiting.push(r));
    active += 1;
    const gap = minGapMs - (Date.now() - lastStart);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastStart = Date.now();
  };
  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  /** Forward one body upstream, waiting out throttling rather than passing it on. */
  async function forward(body: string): Promise<{ status: number; text: string }> {
    for (let attempt = 1; ; attempt++) {
      await acquire();
      let status = 502;
      let text = '{"error":{"message":"proxy failed"}}';
      try {
        const res = await fetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        status = res.status;
        text = await res.text();
        forwarded += 1;
      } catch (err) {
        text = JSON.stringify({ error: { message: (err as Error).message } });
      } finally {
        release();
      }

      const throttled = status === 429 || THROTTLED.test(text);
      if (!throttled || attempt >= attempts) {
        if (throttled) failed += 1;
        return { status, text };
      }
      retried += 1;
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1) + Math.random() * 200));
    }
  }

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const { status, text } = await forward(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(status, { "content-type": "application/json" }).end(text);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.concurrency === undefined ? 0 : 0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("RPC proxy did not bind to a port.");

  return {
    url: `http://127.0.0.1:${address.port}`,
    stats: () => ({ forwarded, retried, failed }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
