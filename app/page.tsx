import { Console } from "@/components/console";
import { Gauge, Wallet, DoorClosed, ShieldCheck, Github, Droplets, Fuel } from "lucide-react";

export default function Home() {
  return (
    <div className="relative">
      {/* header */}
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-primary">
              <Droplets className="size-4" />
            </span>
            Spigot
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-muted-foreground sm:inline">Agentic Economy · Arc</span>
            <a
              href="https://github.com/Risingtell/spigot"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-muted-foreground transition hover:text-foreground"
            >
              <Github className="size-4" />
              <span className="hidden sm:inline">Repo</span>
            </a>
          </div>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="grid-bg pointer-events-none absolute inset-0" />
        <div className="relative mx-auto max-w-4xl px-5 pt-16 pb-6 sm:pt-24">
          <div className="inline-flex items-center gap-2 rounded-full border bg-card/50 px-3 py-1 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            Streaming settlement on Arc, built for autonomous agents
          </div>

          <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
            Agents that pay <span className="text-gradient">by the second</span>, and know when to stop.
          </h1>

          <div className="mt-6 h-px w-40 flow-line" />

          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            An autonomous agent streams a metered service, prices every second it holds against what that second is
            worth, and shuts its own gate the moment the answer turns. It settles in USDC on the cadence Arc&apos;s own
            fee market allows, so the chain never takes more than a few percent of what it moves. No subscription, no
            human clicking pay.
          </p>
        </div>
      </section>

      {/* console */}
      <section className="mx-auto max-w-4xl px-5">
        <div className="rounded-2xl border bg-card/60 card-glow">
          <div className="border-b px-5 py-3 sm:px-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Gauge className="size-4 text-primary" />
              The real agent loop, against Arc&apos;s live fee market. Click and watch.
            </div>
          </div>
          <div className="p-5 sm:p-6">
            <Console />
          </div>
        </div>
      </section>

      {/* how it works */}
      <section className="mx-auto mt-16 max-w-4xl px-5">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">How it works</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: Wallet,
              title: "Open a session",
              body: "The agent, holding a Circle wallet on Arc, opens a metered session with a budget, a rate ceiling, and a goal.",
            },
            {
              icon: Gauge,
              title: "Decide every second",
              body: "Each second it weighs what the next slice is worth against what that slice costs. Its own call, on its own signal.",
            },
            {
              icon: Fuel,
              title: "Settle when it pays",
              body: "Gas on Arc is USDC, so the agent reads the live fee and settles once the amount owed makes that fee a rounding error.",
            },
            {
              icon: DoorClosed,
              title: "Close the gate",
              body: "When value drops below cost, or the budget runs out, it pays off what it owes, stops on its own, and records why.",
            },
          ].map((s, i) => (
            <div key={s.title} className="group relative rounded-xl border bg-card/40 p-5 transition hover:border-primary/40">
              <div className="flex items-center justify-between">
                <s.icon className="size-5 text-primary" />
                <span className="font-mono text-xs text-muted-foreground/60">0{i + 1}</span>
              </div>
              <h3 className="mt-3 font-medium">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* proof */}
      <section className="mx-auto mt-6 max-w-4xl px-5">
        <div className="flex items-start gap-3 rounded-xl border border-accent/25 bg-accent/[0.06] p-5">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Proof, not trust.</span> The settlement layer runs on{" "}
            <a href="https://www.npmjs.com/package/meter402" target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
              meter402
            </a>
            , an open-source npm package, and publishes a snapshot that never claims more than it settled.{" "}
            <span className="font-mono text-foreground">npm run verify</span> re-derives the fee market and every
            settled total straight from Arc, with no keys and nothing of ours in the path. The agent also refills its
            own Arc wallet across chains over CCTP, so a long stream does not end because a human was not watching.
          </p>
        </div>
      </section>

      {/* capability strip */}
      <section className="mx-auto mt-10 max-w-4xl px-5">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          {[
            "Arc Testnet",
            "USDC is the gas",
            "Circle Wallets",
            "CCTP top-up",
            "Bridge Kit",
            "x402 / Gateway",
            "meter402 SDK",
          ].map((c) => (
            <span key={c} className="inline-flex items-center gap-1.5">
              <span className="size-1 rounded-full bg-accent" />
              {c}
            </span>
          ))}
        </div>
      </section>

      <footer className="mx-auto mt-16 max-w-4xl px-5 pb-14">
        <div className="flex items-center justify-between border-t pt-6 text-sm text-muted-foreground">
          <span>Rising Technologies</span>
          <a
            href="https://github.com/Risingtell/spigot"
            className="inline-flex items-center gap-1.5 hover:text-foreground"
            target="_blank"
            rel="noreferrer"
          >
            <Github className="size-4" />
            github.com/Risingtell/spigot
          </a>
        </div>
      </footer>
    </div>
  );
}
