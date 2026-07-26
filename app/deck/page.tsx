import Link from "next/link";
import { ArrowLeft, Droplets } from "lucide-react";

export const metadata = {
  title: "Spigot deck, agent-native streaming settlement on Arc",
  description: "The pitch behind Spigot, in ten slides.",
};

/**
 * The deck. A page rather than a slide file, because a link that always opens,
 * on any device, with no viewer and no download, is worth more to a judge than a
 * deck they have to fetch. Scrolls as slides; prints as slides too.
 */

interface Slide {
  n: string;
  kicker: string;
  title: string;
  body: React.ReactNode;
}

const SLIDES: Slide[] = [
  {
    n: "01",
    kicker: "The gap",
    title: "x402 pays per request. Agents do not consume per request.",
    body: (
      <>
        <p>
          An agent holding a live risk feed, an inference stream, a GPU or a dataset is consuming
          continuously. Billing that as one-shot calls goes wrong in both directions: charge upfront and
          the agent pays for time it never uses; settle afterwards and the provider carries the default
          risk. Putting a human on a checkout button to resolve it defeats the point of an autonomous
          agent.
        </p>
        <p>
          The missing unit is <strong className="text-foreground">time held</strong>, priced by the
          second and settled without anyone approving it.
        </p>
      </>
    ),
  },
  {
    n: "02",
    kicker: "Why now, why Arc",
    title: "Gas and payment are finally the same asset.",
    body: (
      <>
        <p>
          Per-second settlement is absurd on a chain where gas is a separate volatile asset worth more
          than the payment. Arc removes half of that: USDC <em>is</em> the gas token, so the fee and the
          payment are denominated in the same thing and can be compared directly.
        </p>
        <p>
          That comparison is the whole product. It is a measurement, not an opinion, and it is available
          to any agent over a single RPC call.
        </p>
      </>
    ),
  },
  {
    n: "03",
    kicker: "The part demos hide",
    title: "Settling every second would pay the chain more than the provider.",
    body: (
      <>
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure value="~25 gwei" label="Arc gas price, live" />
          <Figure value="$0.0016" label="one settlement" />
          <Figure value="$0.001/sec" label="a market data feed" />
        </div>
        <p>
          A feed priced at a tenth of a cent per second, settled every second, hands the chain more than
          it hands the provider. Most per-second payment demos never run this arithmetic, because on
          testnet with sponsored gas it never bites.
        </p>
      </>
    ),
  },
  {
    n: "04",
    kicker: "The idea",
    title: "Decide every second. Settle when the fee is a rounding error.",
    body: (
      <>
        <p>
          Spigot separates two cadences that per-second billing conflates. The agent{" "}
          <strong className="text-foreground">decides</strong> every second, because that is how often
          the value of the next second changes. It{" "}
          <strong className="text-foreground">settles</strong> only once the amount owed makes Arc&apos;s
          fee a small share of it, reading the live gas price to work out when that is.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure value="~33s" label="on a $0.001/sec feed" />
          <Figure value="~0.65s" label="on $0.05/sec inference" />
          <Figure value="~0.07s" label="on a $0.50/sec GPU" />
        </div>
      </>
    ),
  },
  {
    n: "05",
    kicker: "The mechanism",
    title: "The smallest amount worth settling is the smallest block worth opening.",
    body: (
      <>
        <p>
          Opening a block commits the agent to paying for the whole block, so it only opens one it can
          afford outright, and it always stops on a boundary. If the stream stops earning its price
          partway through, the agent stops buying immediately and rides out what it already committed
          to, rather than walking away from time the provider delivered.
        </p>
        <p>
          That is what holds the fee ceiling on <em>every</em> settlement, the last one included, instead
          of leaking a sub-economical fragment at the end of each session.
        </p>
      </>
    ),
  },
  {
    n: "06",
    kicker: "The autonomy",
    title: "A policy, a value signal, and a gate it shuts itself.",
    body: (
      <>
        <p>
          The agent carries a hard USDC budget, a maximum acceptable rate per second, an objective, and
          an overhead ceiling. Against that it weighs a value signal: what the next slice is worth right
          now, tied to a real input.
        </p>
        <p>Every stop is a recorded decision with a reason:</p>
        <ul className="ml-4 list-disc space-y-1 marker:text-primary">
          <li>the marginal value of the next slice fell below its price</li>
          <li>the budget would not cover another block</li>
          <li>the stream is priced above the ceiling, so the gate never opened</li>
        </ul>
        <p>No human approves anything, at any point.</p>
      </>
    ),
  },
  {
    n: "07",
    kicker: "Built",
    title: "Running today, end to end.",
    body: (
      <>
        <ul className="ml-4 list-disc space-y-1.5 marker:text-primary">
          <li>
            <strong className="text-foreground">Live console</strong> at spigot-taupe.vercel.app running
            the real agent loop against Arc&apos;s live fee market, with three autonomous outcomes.
          </li>
          <li>
            <strong className="text-foreground">Two settlement paths</strong>: Circle
            developer-controlled wallets, and a plain Arc key. Both settle by explicit ERC-20 transfer,
            so both are provable.
          </li>
          <li>
            <strong className="text-foreground">Cross-chain top-up</strong>: an agent low on USDC bridges
            in over CCTP through Circle&apos;s Bridge Kit, with the Forwarder minting so it needs no
            signer on Arc.
          </li>
          <li>
            <strong className="text-foreground">meter402</strong>, the streaming primitive underneath,
            published on npm and open source so any Arc builder can reuse it.
          </li>
          <li>
            <strong className="text-foreground">21 tests</strong> over the rules that move money.
          </li>
        </ul>
      </>
    ),
  },
  {
    n: "08",
    kicker: "Proof",
    title: "Do not trust our numbers. Re-derive them.",
    body: (
      <>
        <pre className="overflow-x-auto rounded-lg border bg-background/60 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
{`git clone https://github.com/Risingtell/spigot
npm install && npm run verify`}
        </pre>
        <p>
          One command, no keys, no wallet. It reads Arc directly for the chain id, block height and live
          gas price, prices one settlement, derives the cadence, and sums every USDC transfer an agent
          made to a provider straight from the token&apos;s transfer logs. Nothing in that path comes
          from a Spigot server.
        </p>
      </>
    ),
  },
  {
    n: "09",
    kicker: "The stack",
    title: "What Spigot uses, and for what.",
    body: (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pb-2 pr-4 font-medium">Flow</th>
              <th className="pb-2 font-medium">Capability</th>
            </tr>
          </thead>
          <tbody className="align-top">
            {[
              ["Wallets on Arc", "Circle developer-controlled wallets, or a plain Arc key"],
              ["Per-second settlement", "USDC on Arc, sub-second finality"],
              ["Settlement cadence", "Arc stable-fee design, USDC as the gas token"],
              ["Refilling itself across chains", "CCTP v2 through Circle Bridge Kit, Arc domain 26"],
              ["Minting on Arc with no signer", "Circle Forwarder"],
              ["Payment envelope per settlement", "x402 and Circle Gateway"],
              ["The streaming layer", "meter402, published npm SDK"],
            ].map(([flow, cap]) => (
              <tr key={flow} className="border-t">
                <td className="py-2 pr-4 text-foreground">{flow}</td>
                <td className="py-2 text-muted-foreground">{cap}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  },
  {
    n: "10",
    kicker: "Where it goes",
    title: "From a working meter to a market.",
    body: (
      <>
        <p>
          The settlement layer is done and provable. What turns it into a business is the other side of
          it: providers listing metered streams, agents discovering and holding them, and a public
          ledger of settlements anyone can audit.
        </p>
        <p>
          Every agent that starts holding services by the second needs exactly one thing first, and it is
          not another wallet. It is a meter that both sides trust. Arc is the only chain where that meter
          can be honest about its own cost.
        </p>
        <div className="flex flex-wrap gap-3 pt-1 text-sm">
          <a className="text-primary underline-offset-4 hover:underline" href="https://spigot-taupe.vercel.app">
            spigot-taupe.vercel.app
          </a>
          <a className="text-primary underline-offset-4 hover:underline" href="https://github.com/Risingtell/spigot">
            github.com/Risingtell/spigot
          </a>
          <a className="text-primary underline-offset-4 hover:underline" href="https://www.npmjs.com/package/meter402">
            npm: meter402
          </a>
        </div>
      </>
    ),
  },
];

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border bg-background/40 px-3.5 py-3">
      <div className="tabular font-mono text-xl text-primary">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function Deck() {
  return (
    <div className="relative">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3.5">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-primary">
              <Droplets className="size-4" />
            </span>
            Spigot
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Live demo</span>
          </Link>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="grid-bg pointer-events-none absolute inset-0" />
        <div className="relative mx-auto max-w-3xl px-5 pt-16 pb-4 sm:pt-24">
          <div className="inline-flex items-center gap-2 rounded-full border bg-card/50 px-3 py-1 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            Programmable Money Hackathon, Agentic Economy track
          </div>
          <h1 className="mt-6 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
            Agents that pay <span className="text-gradient">by the second</span>, and know when to stop.
          </h1>
          <div className="mt-6 h-px w-40 flow-line" />
          <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
            Streaming settlement on Arc, priced against the chain&apos;s own fee market. Built by Rising
            Technologies.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-3xl px-5 pb-20">
        {SLIDES.map((s) => (
          <article
            key={s.n}
            className="mt-6 rounded-2xl border bg-card/60 p-6 card-glow sm:p-8"
            style={{ breakInside: "avoid" }}
          >
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-xs font-medium uppercase tracking-wider text-accent">{s.kicker}</span>
              <span className="font-mono text-xs text-muted-foreground/60">{s.n}</span>
            </div>
            <h2 className="mt-3 text-2xl font-semibold leading-snug tracking-tight">{s.title}</h2>
            <div className="mt-4 space-y-3 text-[0.95rem] leading-relaxed text-muted-foreground">
              {s.body}
            </div>
          </article>
        ))}

        <footer className="mt-10 flex items-center justify-between border-t pt-6 text-sm text-muted-foreground">
          <span>Rising Technologies</span>
          <Link href="/" className="hover:text-foreground">
            Run the agent
          </Link>
        </footer>
      </main>
    </div>
  );
}
