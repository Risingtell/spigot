"use client";

import { useEffect, useState } from "react";

interface Settlement {
  n: number;
  seconds: number;
  amountUsd: number;
  cumulativeUsd: number;
  feeSharePct: number;
  txHash: string;
  explorerUrl?: string;
}
interface RunMeta {
  id: string;
  label: string;
  blurb: string;
  ratePerSecondUsd: number;
  budgetUsd: number;
}
interface Decision {
  reason: string;
  settlements: number;
  ticksMetered: number;
  spentUsd: number;
  feeSharePct: number;
}
interface Fee {
  gasPriceGwei: number;
  source: "live" | "fallback";
  settlementCostUsd: number;
  minSettlementUsd: number;
  cadence?: { label: string; ratePerSecondUsd: number; settleEverySeconds: number }[];
}

interface Delivered {
  n: number;
  units: string;
  settlement: string;
  chunk: { price?: number; tradesPerSecond?: number; spreadBps?: number; observedAt?: string } | null;
}
interface Market {
  openedAtTradesPerSecond: number;
  closedAtTradesPerSecond: number;
  targetTradesPerSecond: number;
}
interface Treasury {
  available: boolean;
  reason?: string;
  spendableOnArcUsd?: number;
  unified?: { totalUsd: number; chains: { chain: string; usd: number }[] };
  policy?: { floorUsd: number; targetUsd: number };
  decision?: { needed: boolean; reason: string; wouldDrawUsd: number };
}

type Rail = "direct" | "nano";

const RAILS: { id: Rail; label: string; note: string }[] = [
  { id: "direct", label: "Direct on Arc", note: "One transaction per settlement, so the agent batches until the fee is a rounding error." },
  { id: "nano", label: "Gas free", note: "Signed off-chain, batched by Circle Gateway. Zero gas per block, so it settles every tick." },
];

/** The live-market run is the real one; the rest are the stated value curves. */
const SCENARIOS = [
  { id: "stale", label: "Queue drains" },
  { id: "fresh", label: "Work keeps coming" },
  { id: "budget", label: "Tight budget" },
];
const LIVE_SIGNAL = "live";

const usd = (n: number) => `$${n.toFixed(6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Console() {
  const [scenario, setScenario] = useState("stale");
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [played, setPlayed] = useState<Settlement[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [fee, setFee] = useState<Fee | null>(null);
  const [mode, setMode] = useState<"live" | "simulated" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [rail, setRail] = useState<Rail>("direct");
  const [delivered, setDelivered] = useState<Delivered[]>([]);
  const [market, setMarket] = useState<Market | null>(null);
  const [treasury, setTreasury] = useState<Treasury | null>(null);

  // The fee market is read on load so the economics are on screen before anyone
  // presses anything. It is a live call to Arc, not a stored constant.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/fee")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setFee(d);
      })
      .catch(() => undefined);
    fetch("/api/treasury")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setTreasury(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function run() {
    setStatus("running");
    setPlayed([]);
    setDecision(null);
    setMeta(null);
    setFailure(null);
    setDelivered([]);
    setMarket(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // On the gas-free rail the default is the real market signal, so no
        // scenario is sent unless one was explicitly picked.
        body: JSON.stringify(scenario === LIVE_SIGNAL ? { rail } : { rail, scenario }),
      });
      if (!res.ok) throw new Error(`the run endpoint answered ${res.status}`);
      const data = await res.json();
      if (data.mode === "unavailable") throw new Error(data.reason ?? "this rail is not available on this deployment");
      if (!Array.isArray(data.settlements)) throw new Error("the run returned no settlements to replay");
      setMeta(data.scenario);
      setMode(data.mode === "live" ? "live" : "simulated");
      if (data.market) setMarket(data.market);
      const chunks: Delivered[] = Array.isArray(data.delivered) ? data.delivered : [];
      if (data.fee) setFee((f) => ({ ...(f ?? {}), ...data.fee }));
      for (const s of data.settlements as Settlement[]) {
        setPlayed((p) => [...p, s]);
        const chunk = chunks[s.n - 1];
        if (chunk) setDelivered((d) => [...d, chunk]);
        await sleep(650);
      }
      setDecision(data.decision);
      setStatus("done");
    } catch (err) {
      // Silently dropping back to idle left the button looking like it did
      // nothing, which reads as broken rather than as a failed call. Say what
      // happened instead.
      setFailure(err instanceof Error ? err.message : "the run could not be completed");
      setStatus("idle");
    }
  }

  const spent = played.length ? played[played.length - 1].cumulativeUsd : 0;
  const seconds = played.reduce((s, t) => s + t.seconds, 0);
  const budget = meta?.budgetUsd ?? 0.6;
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const live = status === "running";
  const started = played.length > 0 || live;

  return (
    <div className="text-[color:hsl(var(--foreground))]">
      {/* live fee market */}
      <div className="border border-white/15 bg-white/[0.03] p-4">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.24em] text-white/50">
          Arc fee market, read live from the public RPC
        </p>
        {fee ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-px bg-white/10 sm:grid-cols-3">
              <Tile label="Gas price" value={`${fee.gasPriceGwei.toFixed(2)} gwei`} />
              <Tile label="One settlement" value={usd(fee.settlementCostUsd)} />
              <Tile label="Worth settling above" value={usd(fee.minSettlementUsd)} />
            </div>
            {fee.cadence && fee.cadence.length > 0 && (
              <p className="mt-3 text-[0.82rem] leading-relaxed text-white/60">
                At this price it settles about every{" "}
                {fee.cadence.map((c, i, all) => (
                  <span key={c.label}>
                    <span className="text-white">{c.settleEverySeconds.toFixed(1)}s</span> on a{" "}
                    {usd(c.ratePerSecondUsd)}/sec {c.label}
                    {i < all.length - 1 ? ", " : ". "}
                  </span>
                ))}
                It meters every tick either way, so nothing is lost between settlements.
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 text-[0.82rem] text-white/50">Reading Arc.</p>
        )}
      </div>

      {/* which rail the same agent settles on */}
      <div className="mt-6">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.24em] text-white/50">
          Same agent, same policy, two rails
        </p>
        <div className="mt-3 grid gap-px bg-white/10 sm:grid-cols-2">
          {RAILS.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                setRail(r.id);
                setScenario(r.id === "nano" ? LIVE_SIGNAL : "stale");
              }}
              disabled={live}
              className={`p-4 text-left transition disabled:opacity-50 ${
                rail === r.id ? "bg-[color:var(--amber)] text-black" : "bg-black/40 text-white/70 hover:bg-black/20"
              }`}
            >
              <span className="block text-[0.72rem] font-bold uppercase tracking-[0.16em]">{r.label}</span>
              <span className={`mt-1 block text-[0.78rem] leading-snug ${rail === r.id ? "text-black/75" : "text-white/45"}`}>
                {r.note}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* what the agent is ruling on */}
      <div className="mt-5 flex flex-wrap gap-2">
        {rail === "nano" && (
          <button
            onClick={() => setScenario(LIVE_SIGNAL)}
            disabled={live}
            className={`border px-4 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition disabled:opacity-50 ${
              scenario === LIVE_SIGNAL
                ? "border-[color:var(--amber)] bg-[color:var(--amber)] text-black"
                : "border-white/25 text-white/70 hover:border-white/60 hover:text-white"
            }`}
          >
            Live market signal
          </button>
        )}
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => setScenario(s.id)}
            disabled={live}
            className={`border px-4 py-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] transition disabled:opacity-50 ${
              scenario === s.id
                ? "border-[color:var(--amber)] bg-[color:var(--amber)] text-black"
                : "border-white/25 text-white/70 hover:border-white/60 hover:text-white"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <button
          onClick={run}
          disabled={live}
          className="inline-flex items-center gap-2 border-2 border-[color:var(--amber)] bg-[color:var(--amber)] px-7 py-3.5 text-[0.78rem] font-bold uppercase tracking-[0.16em] text-black transition hover:bg-white hover:border-white disabled:opacity-60"
        >
          {live ? "Agent is streaming" : "Run the agent"}
        </button>

        <div
          className={`inline-flex items-center gap-2 px-3 py-1.5 text-[0.66rem] font-bold uppercase tracking-[0.2em] ${
            live
              ? "bg-[color:var(--amber)] text-black animate-live"
              : status === "done"
                ? "border border-white/30 text-white/70"
                : "border border-white/15 text-white/40"
          }`}
        >
          {live ? "Gate open" : status === "done" ? "Gate closed" : "Idle"}
        </div>
      </div>

      {failure && (
        <p className="mt-3 border-l-4 border-[color:var(--destructive)] bg-white/[0.04] px-4 py-3 text-[0.8rem] text-white/70">
          The run did not complete: {failure}. Nothing was settled. Press run again, or re-derive the settled history
          from Arc with <span className="font-mono text-white">npm run verify</span>.
        </p>
      )}

      {mode && !failure && (
        <p className="mt-3 text-[0.8rem] text-white/55">
          {rail === "nano"
            ? "Signed off-chain and settled by Circle Gateway. No gas was paid on any block below."
            : mode === "live"
              ? "Settling real USDC on Arc Testnet."
              : "Settling against a simulated provider on this run."}
        </p>
      )}

      {market && (
        <div className="mt-4 border-l-4 border-[color:var(--green)] bg-white/[0.04] px-4 py-3 text-[0.82rem] leading-relaxed text-white/70">
          The agent watched the market before opening the gate and measured{" "}
          <span className="tabular font-mono text-white">{market.openedAtTradesPerSecond.toFixed(2)}</span> trades/sec,
          so it held the feed to a bar of{" "}
          <span className="tabular font-mono text-white">{market.targetTradesPerSecond.toFixed(2)}</span>. Flow was{" "}
          <span className="tabular font-mono text-white">{market.closedAtTradesPerSecond.toFixed(2)}</span> when it
          stopped. The bar is measured, not hardcoded, so the same policy works in a busy hour and a dead one.
        </div>
      )}

      {/* live stat row */}
      <div className="mt-5 grid grid-cols-3 gap-px bg-white/10">
        <Tile label="Settlements" value={String(played.length)} />
        <Tile label="Total settled" value={usd(spent)} />
        <Tile label="Time held" value={`${seconds.toFixed(2)}s`} />
      </div>

      {/* budget meter */}
      <div className="mt-5">
        <div className="mb-2 flex justify-between text-[0.66rem] font-bold uppercase tracking-[0.18em] text-white/50">
          <span>Agent budget</span>
          <span className="tabular font-mono tracking-normal">
            {usd(spent)} of {usd(budget)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden bg-white/12">
          <div
            className="h-full bg-[color:var(--amber)] transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* settlement log */}
      <div className="mt-5 min-h-[11rem] border border-white/15 bg-black/40 p-4 font-mono text-[0.85rem]">
        {!started ? (
          <p className="px-1 py-10 text-center text-white/40">
            Pick a scenario and run the agent. Each row is one settlement, covering every second the agent held since
            the last one.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {played.map((t) => (
              <li key={t.n} className="animate-tick flex items-center justify-between gap-3">
                <span className="text-white/45">
                  {String(t.n).padStart(2, "0")} · {t.seconds.toFixed(2)}s held
                </span>
                <span className="tabular text-[color:var(--amber)]">+{usd(t.amountUsd)}</span>
                <span className="tabular hidden text-white/45 sm:inline">
                  {rail === "nano" ? "gas $0.00" : `fee ${t.feeSharePct.toFixed(1)}%`}
                </span>
                {t.explorerUrl ? (
                  <a
                    href={t.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-xs text-[color:var(--green)] underline-offset-2 hover:underline"
                  >
                    {t.txHash.slice(0, 10)}…
                  </a>
                ) : (
                  <span className="truncate text-xs text-white/30">{t.txHash.slice(0, 10)}…</span>
                )}
                {(() => {
                  // On the gas-free rail the response to the payment IS the chunk,
                  // so show what actually arrived rather than only what was paid.
                  const d = delivered.find((x) => x.n === t.n);
                  if (!d?.chunk?.price) return null;
                  return (
                    <span className="tabular hidden text-[color:var(--green)] md:inline">
                      BTC ${d.chunk.price.toLocaleString()}
                    </span>
                  );
                })()}
              </li>
            ))}
            {live && (
              <li className="flex items-center gap-2 py-1 text-white/45">
                <span className="inline-block size-1.5 bg-[color:var(--amber)] animate-drip" />
                metering the next second…
              </li>
            )}
          </ul>
        )}
      </div>

      {/* decision */}
      {decision && (
        <div className="animate-tick mt-5 border-l-4 border-[color:var(--amber)] bg-white/[0.04] p-5">
          <p className="text-[0.95rem]">
            <span className="font-bold uppercase tracking-[0.06em] text-[color:var(--amber)]">
              Agent closed its own gate
            </span>{" "}
            after ruling on {decision.ticksMetered} {decision.ticksMetered === 1 ? "interval" : "intervals"} and
            settling {decision.settlements} {decision.settlements === 1 ? "time" : "times"}.
          </p>
          <p className="mt-2 text-[0.9rem] leading-relaxed text-white/65">
            Reason: <span className="text-white">{decision.reason}</span>. Paid{" "}
            <span className="tabular font-mono text-white">{usd(decision.spentUsd)}</span>
            {rail === "nano" ? (
              <>
                , and <span className="tabular font-mono text-white">$0.00</span> of it went to gas, because Circle
                batched the settlement instead of broadcasting one per block.
              </>
            ) : (
              <>
                , of which Arc took{" "}
                <span className="tabular font-mono text-white">{decision.feeSharePct.toFixed(1)}%</span> in fees.
              </>
            )}{" "}
            The rest of the budget stays with the agent. No human in the loop.
          </p>
        </div>
      )}

      {meta && (
        <p className="mt-4 text-[0.8rem] leading-relaxed text-white/45">
          {meta.blurb} Priced at {usd(meta.ratePerSecondUsd)}/sec.{" "}
          {rail === "nano"
            ? "Each row above is a block the agent paid for off-chain and received the next chunk of the feed in return, so the payment is the gate."
            : mode === "live"
              ? "Every settlement above is a confirmed USDC transfer on Arc Testnet. Follow any hash to the explorer, or re-derive the whole set with npm run verify."
              : "The loop, the fee market and the cadence are identical to the live path in src/run-live.ts, which moves real USDC on Arc."}
        </p>
      )}

      {/* what the agent can spend, and where it actually sits */}
      {treasury?.available && treasury.unified && (
        <div className="mt-6 border border-white/15 bg-white/[0.03] p-4">
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.24em] text-white/50">
            The agent&apos;s own treasury, read live from Arc and Circle
          </p>
          <div className="mt-3 grid grid-cols-2 gap-px bg-white/10 sm:grid-cols-3">
            <Tile label="Spendable on Arc" value={`$${(treasury.spendableOnArcUsd ?? 0).toFixed(2)}`} />
            <Tile label="Unified balance" value={`$${treasury.unified.totalUsd.toFixed(2)}`} />
            <Tile label="Tops up below" value={`$${(treasury.policy?.floorUsd ?? 0).toFixed(2)}`} />
          </div>
          <p className="mt-3 text-[0.82rem] leading-relaxed text-white/60">
            Spendable on Arc is what a settlement comes out of. The unified balance is everything the agent holds
            through Circle Gateway,{" "}
            {treasury.unified.chains.length > 0 ? (
              <>
                currently across{" "}
                {treasury.unified.chains.map((c, i, all) => (
                  <span key={c.chain}>
                    <span className="text-white">{c.chain.replace(/_/g, " ")}</span>
                    {i < all.length - 1 ? ", " : ""}
                  </span>
                ))}
              </>
            ) : (
              "on any chain"
            )}
            . When Arc falls below the floor the agent draws from that on its own, and Circle&apos;s auto-allocation
            picks the source chains rather than the agent naming one.{" "}
            <span className="text-white/80">
              {treasury.decision?.needed
                ? `Right now it would draw $${(treasury.decision.wouldDrawUsd ?? 0).toFixed(2)}.`
                : "Right now it is above the floor, so it holds."}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-black/40 px-4 py-3">
      <div className="text-[0.6rem] font-bold uppercase tracking-[0.2em] text-white/45">{label}</div>
      <div className="tabular mt-1 font-mono text-[1.05rem] text-white">{value}</div>
    </div>
  );
}
