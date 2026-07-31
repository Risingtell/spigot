import Link from "next/link";
import { Reveal } from "@/components/reveal";
import { SpigotMark } from "@/components/mark";

export const metadata = {
  title: "Spigot deck, the agent that decides what to buy and when to stop",
  description: "Circle built the rail. Spigot is the demand side.",
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
    kicker: "Where we sit",
    title: (
      <>
        Circle built the rail. <span className="hl">Spigot is the buyer</span>
      </>
    ),
    body: (
      <>
        <p>
          Look at the Agent Stack: wallets, nanopayments, a marketplace, a CLI, skills. It is a complete supply side.
          An agent can hold money, move it for nothing, discover a service and pay for it.
        </p>
        <p>
          None of it decides <em>whether the next second is worth buying</em>. That judgement is the whole of the
          demand side, and it is what Spigot is: a budget it cannot breach, a price ceiling it will not cross, a value
          signal tied to something real, and a gate it shuts on itself.
        </p>
        <p>
          We settle through Circle rather than around it. The rail is theirs and it is excellent. The buyer is the part
          nobody had built.
        </p>
      </>
    ),
  },
  {
    n: "03",
    kicker: "Two rails, one agent",
    title: <>The same policy, whatever the payment costs</>,
    body: (
      <>
        <p>
          Settling directly on Arc costs gas, so the agent batches: it reads the live fee, works out the smallest block
          worth settling, and waits until a block clears it. Through Circle Nanopayments the signature is off-chain and
          Circle batches the on-chain settlement, so gas per block is zero and the agent settles every single tick at a
          fraction of a cent.
        </p>
        <Figs
          items={[
            ["~$0.0016", "gas per direct settlement"],
            ["$0.00", "gas per nanopayment"],
            ["1 agent", "identical policy on both"],
          ]}
        />
        <p>
          Both are live and both are running. The economics change completely between them; the decision logic does not
          change at all. That is the point of putting the judgement in the buyer.
        </p>
      </>
    ),
  },
  {
    n: "04",
    kicker: "The mechanism",
    title: (
      <>
        The smallest amount worth settling is <span className="hl">the smallest block</span> worth opening
      </>
    ),
    body: (
      <>
        <p>
          On the metered rail, opening a block commits the agent to paying for the whole block, so it only opens one it
          can afford outright and it always stops on a boundary. If the stream stops earning its price partway through,
          the agent stops buying at once and rides out what it already committed to, rather than walking away from time
          the provider delivered.
        </p>
        <p>
          That is what holds the fee ceiling on every settlement including the last, instead of leaking a
          sub-economical fragment at the end of every session.
        </p>
      </>
    ),
  },
  {
    n: "05",
    kicker: "The signal",
    title: (
      <>
        We measured the signal <span className="hl">before trusting it</span>
      </>
    ),
    body: (
      <>
        <p>
          The agent buys a live BTC risk feed, so the obvious value signal was price movement. We measured it before
          building on it. Sampled once a second against spot, <strong>eight of nine samples came back unchanged</strong>,
          a mean move of 0.0002bps. At three seconds all nine were identical. That signal is dead at this cadence, and
          tuning a threshold low enough to make it look alive would have been theatre.
        </p>
        <p>
          Trade flow does move. The exchange ticker carries a monotonic trade id, so the difference between two samples
          is exactly how many trades happened in between: <strong>2 to 10 per second</strong> over the same window that
          produced the flat prices. The agent rules on that, and anyone can check it against the same public endpoint.
        </p>
        <p>A live run bought while flow held near 4 per second and closed its own gate when it fell to 3.63.</p>
      </>
    ),
  },
  {
    n: "06",
    kicker: "The gate is the payment",
    title: <>There is no delivery step to trust</>,
    body: (
      <>
        <p>
          Spigot ships the provider side too: an x402-protected endpoint that prices each 402 challenge at exactly what
          the block owes. The agent signs, Circle verifies and settles, and the response body <em>is</em> the next chunk
          of the stream.
        </p>
        <p>
          Payment and delivery are the same request. Nothing is layered on top promising that the buyer got what it
          paid for. Stop paying and the next chunk simply never arrives.
        </p>
      </>
    ),
  },
  {
    n: "07",
    kicker: "Proof",
    title: (
      <>
        A public record that <span className="hl">stores nothing</span>
      </>
    ),
    body: (
      <>
        <p>
          Most projects publish a number from their own database and ask you to believe it. Spigot holds none. Every
          figure on <span className="mono">/api/impact</span> is fetched on request from a ledger we do not control:
          direct settlements from Arc&apos;s USDC transfer log, gas-free settlements from Circle&apos;s own Gateway API.
        </p>
        <div className="codeblock">
          {`git clone https://github.com/Risingtell/spigot
npm install && npm run verify`}
        </div>
        <p style={{ marginTop: "1.25rem" }}>
          One command, no keys, no configuration. It re-derives the on-chain half independently and holds the published
          feed against the chain. The feed claims the on-chain figure alone, never the combined one, because the chain
          can only back what settled on it.
        </p>
      </>
    ),
  },
  {
    n: "08",
    kicker: "Honesty as a feature",
    title: <>The tooling caught us overclaiming</>,
    body: (
      <>
        <p>
          When the feed first went up it reported five settlements totalling $2.46. The agent had settled four
          totalling $0.46. The difference was the $2 deposit that funded the Gateway balance, counted as revenue
          because it is also a transfer out of the agent.
        </p>
        <p>
          Both the feed and the verifier now scope the figure to transfers that actually reached the provider, and
          report anything else as movement, named explicitly. The verifier still prints the larger raw chain figure
          next to the smaller claim, so the invariant stays visible instead of hiding behind a filter.
        </p>
        <p>
          A payments product that cannot catch itself inflating a number is not one you should run money through.
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
              ["Gas-free sub-cent settlement", "Circle Nanopayments over Gateway"],
              ["Selling a metered stream", "x402 challenge priced per block, BatchFacilitatorClient"],
              ["Direct on-chain settlement", "USDC on Arc, explicit ERC-20 transfer so it is provable"],
              ["Wallets", "Circle developer-controlled wallets, or a plain Arc key"],
              ["Settlement cadence", "Arc stable-fee design, USDC as the gas token"],
              ["Refilling across chains", "CCTP v2 through Circle Bridge Kit, Arc domain 26"],
              ["The streaming layer", "meter402, our own npm package, MIT"],
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
        Every agent economy needs <span className="hl">a buyer with judgement</span>
      </>
    ),
    body: (
      <>
        <p>
          The rails are being built well and fast, by Circle and by others. What is missing is the side that decides.
          An agent with a wallet and no policy is not autonomous, it is just unattended.
        </p>
        <p>
          Spigot is that policy, running against real money on two rails, with a public record anyone can re-derive.
          The next step is more streams and more providers on the same meter, which is why the settlement primitive
          underneath is open source rather than ours alone.
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
            <h1 className="h-lg">Circle built the rail. Spigot is the agent that decides what to buy on it</h1>
            <p className="lede">
              Streaming settlement on Arc, live on two rails, with a public record that stores nothing. Programmable
              Money Hackathon, Agentic Economy track. Built by Rising Technology.
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
              <h2 className="h-lg">The console settles real USDC</h2>
              <p>
                Pick a scenario and watch an agent hold a stream, settle it on Arc, and close its own gate. Every
                settlement links to the explorer.
              </p>
            </div>
            <div className="hero__cta">
              <Link className="btn" href="/">
                Run the agent{" "}
                <span className="arw" aria-hidden="true">
                  &rarr;
                </span>
              </Link>
              <a className="btn btn--ghost" href="/api/impact">
                The public record
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="ftr">
        <div className="wrap">
          <div className="ftr__bot" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
            <span>Rising Technology</span>
            <span>spigot-taupe.vercel.app</span>
          </div>
        </div>
      </footer>
    </>
  );
}
