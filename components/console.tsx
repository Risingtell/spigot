"use client";

import { useEffect, useState } from "react";
import { Play, LoaderCircle, DoorClosed, Radio, Fuel } from "lucide-react";

interface Settlement {
  n: number;
  seconds: number;
  amountUsd: number;
  cumulativeUsd: number;
  feeSharePct: number;
  txHash: string;
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

const SCENARIOS = [
  { id: "stale", label: "Queue drains" },
  { id: "fresh", label: "Work keeps coming" },
  { id: "budget", label: "Tight budget" },
];

const usd = (n: number) => `$${n.toFixed(6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Console() {
  const [scenario, setScenario] = useState("stale");
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [played, setPlayed] = useState<Settlement[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [fee, setFee] = useState<Fee | null>(null);

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
    return () => {
      cancelled = true;
    };
  }, []);

  async function run() {
    setStatus("running");
    setPlayed([]);
    setDecision(null);
    setMeta(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const data = await res.json();
      setMeta(data.scenario);
      if (data.fee) setFee((f) => ({ ...(f ?? {}), ...data.fee }));
      for (const s of data.settlements as Settlement[]) {
        setPlayed((p) => [...p, s]);
        await sleep(650);
      }
      setDecision(data.decision);
      setStatus("done");
    } catch {
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
    <div>
      {/* live fee market */}
      <div className="mb-5 rounded-xl border bg-background/40 p-3.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Fuel className="size-3.5" />
          <span>Arc fee market, read live from the public RPC</span>
        </div>
        {fee ? (
          <>
            <div className="mt-2.5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Gas price" value={`${fee.gasPriceGwei.toFixed(2)} gwei`} />
              <Stat label="One settlement costs" value={usd(fee.settlementCostUsd)} />
              <Stat label="Worth settling above" value={usd(fee.minSettlementUsd)} />
            </div>
            {fee.cadence && fee.cadence.length > 0 && (
              <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
                Gas on Arc is USDC, so the fee and the payment are the same asset and the agent can schedule around
                it. At this price it settles about every{" "}
                {fee.cadence.map((c, i, all) => (
                  <span key={c.label}>
                    <span className="text-foreground">{c.settleEverySeconds.toFixed(1)}s</span> on a{" "}
                    {usd(c.ratePerSecondUsd)}/sec {c.label}
                    {i < all.length - 1 ? ", " : ". "}
                  </span>
                ))}
                It meters every tick either way, so nothing is lost between settlements.
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Reading Arc.</p>
        )}
      </div>

      {/* scenario picker */}
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => setScenario(s.id)}
            disabled={live}
            className={`rounded-full border px-3.5 py-1.5 text-sm transition ${
              scenario === s.id
                ? "border-primary bg-primary/15 text-primary"
                : "text-muted-foreground hover:border-primary/40 hover:text-foreground"
            } disabled:opacity-50`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <button
          onClick={run}
          disabled={live}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {live ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
          {live ? "Agent is streaming" : "Run the agent"}
        </button>

        <div
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
            live
              ? "bg-primary/15 text-primary animate-live"
              : status === "done"
                ? "bg-destructive/15 text-destructive"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {live ? <Radio className="size-3.5" /> : status === "done" ? <DoorClosed className="size-3.5" /> : null}
          {live ? "GATE OPEN" : status === "done" ? "GATE CLOSED" : "IDLE"}
        </div>
      </div>

      {/* live stat row */}
      <div className="mt-5 grid grid-cols-3 gap-3">
        <Stat label="Settlements" value={String(played.length)} />
        <Stat label="Total settled" value={usd(spent)} />
        <Stat label="Time held" value={`${seconds.toFixed(2)}s`} />
      </div>

      {/* budget meter */}
      <div className="mt-4">
        <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
          <span>Agent budget</span>
          <span className="tabular">
            {usd(spent)} of {usd(budget)}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* settlement log */}
      <div className="mt-4 min-h-[10rem] rounded-xl border bg-background/50 p-3 font-mono text-sm">
        {!started ? (
          <p className="px-1 py-8 text-center text-muted-foreground">
            Pick a scenario and run the agent. Each row is one settlement, covering every second the agent held since
            the last one.
          </p>
        ) : (
          <ul className="space-y-1">
            {played.map((t) => (
              <li key={t.n} className="animate-tick flex items-center justify-between gap-3 px-1">
                <span className="text-muted-foreground">
                  {String(t.n).padStart(2, "0")} · {t.seconds.toFixed(2)}s held
                </span>
                <span className="tabular text-primary">+{usd(t.amountUsd)}</span>
                <span className="tabular hidden text-muted-foreground sm:inline">fee {t.feeSharePct.toFixed(1)}%</span>
                <span className="truncate text-xs text-muted-foreground/60">{t.txHash.slice(0, 10)}…</span>
              </li>
            ))}
            {live && (
              <li className="flex items-center gap-2 px-1 py-1 text-muted-foreground/70">
                <span className="inline-block size-1.5 rounded-full bg-primary animate-drip" />
                metering the next second…
              </li>
            )}
          </ul>
        )}
      </div>

      {/* decision */}
      {decision && (
        <div className="animate-tick mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
          <p className="text-sm">
            <span className="font-medium text-destructive">Agent closed its own gate</span> after ruling on{" "}
            {decision.ticksMetered} {decision.ticksMetered === 1 ? "interval" : "intervals"} and settling{" "}
            {decision.settlements} {decision.settlements === 1 ? "time" : "times"}.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Reason: <span className="text-foreground">{decision.reason}</span>. Paid{" "}
            <span className="tabular text-foreground">{usd(decision.spentUsd)}</span>, of which Arc took{" "}
            <span className="tabular text-foreground">{decision.feeSharePct.toFixed(1)}%</span> in fees. The rest of the
            budget stays with the agent. No human in the loop.
          </p>
        </div>
      )}

      {meta && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {meta.blurb} Capacity priced at {usd(meta.ratePerSecondUsd)}/sec. Settlement is simulated on this hosted
          demo, which holds no keys; the fee market above is live, and the same loop settles real USDC on Arc when
          Circle wallets are wired in.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-background/40 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular mt-0.5 font-mono text-base text-foreground">{value}</div>
    </div>
  );
}
