import Link from "next/link";
import { Reveal } from "@/components/reveal";
import { SpigotMark } from "@/components/mark";

export const metadata = {
  title: "Spigot deck, agent-native streaming settlement on Arc",
  description: "The pitch behind Spigot, in ten slides.",
};

/**
 * The deck. A page rather than a slide file, because a link that always opens, on
 * any device, with no viewer and no download, is worth more to a judge than a deck
 * they have to fetch.
 */

interface Slide {
  n: string;
  kicker: string;
  title: React.ReactNode;
  body: React.ReactNode;
}

function Figs({ items }: { items: [string, string][] }) {
  return (
    <div className="figrow">
      {items.map(([v, l]) => (
        <div className="fig" key={l}>
          <span className="fig__v">{v}</span>
          <span className="fig__l">{l}</span>
        </div>
      ))}
    </div>
  );
}

const SLIDES: Slide[] = [
  {
    n: "01",
    kicker: "The gap",
    title: (
      <>
        x402 pays per request. <span className="hl">Agents do not</span> consume per request.
      </>
    ),
    body: (
      <>
        <p>
          An agent holding a live risk feed, an inference stream, a GPU or a dataset is consuming continuously. Billing
          that as one-shot calls goes wrong in both directions: charge upfront and the agent pays for time it never
          uses; settle afterwards and the provider carries the default risk. Putting a human on a checkout button to
          resolve it defeats the point of an autonomous agent.
        </p>
        <p>The missing unit is time held, priced by the second and settled without anyone approving it.</p>
      </>
    ),
  },
  {
    n: "02",
    kicker: "Why now, why Arc",
    title: (
      <>
        Gas and payment are finally <span className="hl">the same asset</span>
      </>
    ),
    body: (
      <>
        <p>
          Per-second settlement is absurd on a chain where gas is a separate volatile asset worth more than the payment.
          Arc removes half of that: USDC is the gas token, so the fee and the payment are denominated in the same thing
          and can be compared directly.
        </p>
        <p>
          That comparison is the whole product. It is a measurement, not an opinion, and it is available to any agent
          over a single RPC call.
        </p>
      </>
    ),
  },
  {
    n: "03",
    kicker: "The part demos hide",
    title: (
      <>
        Settling every second would pay <span className="hl">the chain more</span> than the provider
      </>
    ),
    body: (
      <>
        <Figs
          items={[
            ["~25 gwei", "Arc gas price, live"],
            ["$0.0016", "one settlement"],
            ["$0.001/sec", "a market data feed"],
          ]}
        />
        <p>
          A feed priced at a tenth of a cent per second, settled every second, hands the chain more than it hands the
          provider. Most per-second payment demos never run this arithmetic, because on testnet with sponsored gas it
          never bites.
        </p>
      </>
    ),
  },
  {
    n: "04",
    kicker: "The idea",
    title: (
      <>
        Decide every second. <span className="hl">Settle when it pays</span>
      </>
    ),
    body: (
      <>
        <p>
          Spigot separates two cadences that per-second billing conflates. The agent decides every second, because that
          is how often the value of the next second changes. It settles only once the amount owed makes Arc&apos;s fee a
          small share of it, reading the live gas price to work out when that is.
        </p>
        <Figs
          items={[
            ["~33s", "on a $0.001/sec feed"],
            ["~0.65s", "on $0.05/sec inference"],
            ["~0.07s", "on a $0.50/sec GPU"],
          ]}
        />
      </>
    ),
  },
  {
    n: "05",
    kicker: "The mechanism",
    title: (
      <>
        The smallest amount worth settling is <span className="hl">the smallest block</span> worth opening
      </>
    ),
    body: (
      <>
        <p>
          Opening a block commits the agent to paying for the whole block, so it only opens one it can afford outright,
          and it always stops on a boundary. If the stream stops earning its price partway through, the agent stops
          buying immediately and rides out what it already committed to, rather than walking away from time the provider
          delivered.
        </p>
        <p>
          That is what holds the fee ceiling on every settlement, the last one included, instead of leaking a
          sub-economical fragment at the end of each session.
        </p>
      </>
    ),
  },
  {
    n: "06",
    kicker: "The autonomy",
    title: (
      <>
        A policy, a value signal, and <span className="hl">a gate it shuts itself</span>
      </>
    ),
    body: (
      <>
        <p>
          The agent carries a hard USDC budget, a maximum acceptable rate per second, an objective, and an overhead
          ceiling. Against that it weighs a value signal: what the next slice is worth right now, tied to a real input.
        </p>
        <p>Every stop is a recorded decision with a reason:</p>
        <ul className="ml-5 list-disc space-y-1">
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
    title: <>Running today, end to end</>,
    body: (
      <ul className="ml-5 list-disc space-y-2">
        <li>
          <b>Live console</b> running the real agent loop against Arc&apos;s live fee market, with three autonomous
          outcomes.
        </li>
        <li>
          <b>Two settlement paths</b>: Circle developer-controlled wallets, and a plain Arc key. Both settle by explicit
          ERC-20 transfer, so both are provable.
        </li>
        <li>
          <b>Cross-chain top-up</b>: an agent low on USDC bridges in over CCTP through Circle&apos;s Bridge Kit, with
          the Forwarder minting so it needs no signer on Arc.
        </li>
        <li>
          <b>meter402</b>, the streaming primitive underneath, published on npm and open source so any Arc builder can
          reuse it.
        </li>
        <li>
          <b>21 tests</b> over the rules that move money.
        </li>
      </ul>
    ),
  },
  {
    n: "08",
    kicker: "Proof",
    title: (
      <>
        Do not trust our numbers. <span className="hl">Re-derive them</span>
      </>
    ),
    body: (
      <>
        <div className="codeblock">
          {`git clone https://github.com/Risingtell/spigot
npm install && npm run verify`}
        </div>
        <p style={{ marginTop: "1.25rem" }}>
          One command, no keys, no wallet. It reads Arc directly for the chain id, block height and live gas price,
          prices one settlement, derives the cadence, and sums every USDC transfer an agent made to a provider straight
          from the token&apos;s transfer logs. Nothing in that path comes from a Spigot server.
        </p>
      </>
    ),
  },
  {
    n: "09",
    kicker: "The stack",
    title: <>What Spigot uses, and for what</>,
    body: (
      <table className="captable">
        <thead>
          <tr>
            <th>Flow</th>
            <th>Capability</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ["Wallets on Arc", "Circle developer-controlled wallets, or a plain Arc key"],
              ["Per-second settlement", "USDC on Arc, sub-second finality"],
              ["Settlement cadence", "Arc stable-fee design, USDC as the gas token"],
              ["Refilling across chains", "CCTP v2 through Circle Bridge Kit, Arc domain 26"],
              ["Minting with no signer on Arc", "Circle Forwarder"],
              ["Payment envelope", "x402 and Circle Gateway"],
              ["The streaming layer", "meter402, published npm SDK"],
            ] as [string, string][]
          ).map(([flow, cap]) => (
            <tr key={flow}>
              <td>{flow}</td>
              <td>{cap}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
  },
  {
    n: "10",
    kicker: "Where it goes",
    title: (
      <>
        From a working meter to <span className="hl">a market</span>
      </>
    ),
    body: (
      <>
        <p>
          The settlement layer is done and provable. What turns it into a business is the other side of it: providers
          listing metered streams, agents discovering and holding them, and a public ledger of settlements anyone can
          audit.
        </p>
        <p>
          Every agent that starts holding services by the second needs exactly one thing first, and it is not another
          wallet. It is a meter that both sides trust. Arc is the only chain where that meter can be honest about its
          own cost.
        </p>
      </>
    ),
  },
];

export default function Deck() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Reveal />

      <header className="hdr">
        <div className="hdr__in">
          <Link className="brand" href="/">
            <SpigotMark className="brand__mark" />
            Spigot
          </Link>
          <nav className="nav" aria-label="Main">
            <Link className="nav__hide" href="/">
              Live console
            </Link>
            <a className="nav__hide" href="https://github.com/Risingtell/spigot" target="_blank" rel="noreferrer">
              Repo
            </a>
            <Link className="btn btn--onDark" href="/">
              Run the agent{" "}
              <span className="arw" aria-hidden="true">
                &rarr;
              </span>
            </Link>
          </nav>
        </div>
      </header>

      <main id="main">
        <section className="phero">
          <div className="pat pat--diag" aria-hidden="true" />
          <div className="wrap phero__in">
            <p className="crumb">
              <Link href="/">Spigot</Link> &middot; Deck
            </p>
            <h1 className="h-lg">
              Agents that pay by the second, and know when to stop
            </h1>
            <p className="lede">
              Streaming settlement on Arc, priced against the chain&apos;s own fee market. Programmable Money Hackathon,
              Agentic Economy track. Built by Rising Technologies.
            </p>
          </div>
        </section>

        <section>
          <div className="wrap">
            {SLIDES.map((s) => (
              <article className="slide rv" key={s.n}>
                <div className="slide__head">
                  <p className="eyebrow" style={{ margin: 0 }}>
                    {s.kicker}
                  </p>
                  <span className="slide__no">{s.n}</span>
                </div>
                <h2 className="h-md">{s.title}</h2>
                <div className="prose" style={{ marginTop: "1.25rem", maxWidth: "72ch" }}>
                  {s.body}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="cta">
          <div className="pat pat--brick" aria-hidden="true" />
          <div className="wrap cta__in">
            <div>
              <p className="eyebrow eyebrow--onAmber">See it run</p>
              <h2 className="h-lg">The console is live</h2>
              <p>Pick a scenario and watch an agent hold a stream, settle it, and close its own gate.</p>
            </div>
            <div className="hero__cta">
              <Link className="btn" href="/">
                Run the agent{" "}
                <span className="arw" aria-hidden="true">
                  &rarr;
                </span>
              </Link>
              <a className="btn btn--ghost" href="https://github.com/Risingtell/spigot" target="_blank" rel="noreferrer">
                View the repo
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="ftr">
        <div className="wrap">
          <div className="ftr__bot" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
            <span>Rising Technologies</span>
            <span>spigot-taupe.vercel.app</span>
          </div>
        </div>
      </footer>
    </>
  );
}
