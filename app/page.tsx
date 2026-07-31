import Link from "next/link";
import { Console } from "@/components/console";
import { Reveal } from "@/components/reveal";
import { SpigotMark } from "@/components/mark";

const HOW = [
  {
    no: "01",
    title: "Open a session",
    body: "The agent, holding a wallet on Arc, opens a metered session carrying a hard USDC budget, a rate ceiling, an objective and an overhead ceiling.",
  },
  {
    no: "02",
    title: "Decide every second",
    body: "Each second it weighs what the next slice is worth against what that slice costs. Its own call, on its own signal, with nobody to ask.",
  },
  {
    no: "03",
    title: "Settle when it pays",
    body: "Gas on Arc is USDC, so the agent reads the live fee and settles once the amount owed makes that fee a rounding error against it.",
  },
  {
    no: "04",
    title: "Close the gate",
    body: "When value drops below cost, or the budget will not cover another block, it pays off what it owes, stops on its own, and records why.",
  },
];

const INVARIANTS = [
  {
    t: "Every settlement clears the floor",
    d: "The smallest amount worth settling is also the smallest block of time worth opening, so the agent always stops on a block boundary. No sub-economical fragment at the end of a session.",
  },
  {
    t: "The budget cannot be breached",
    d: "A block is opened only if the whole block fits inside what is left. An agent that cannot fund one worthwhile settlement declines before consuming anything.",
  },
  {
    t: "Delivered time is always paid for",
    d: "Metered time rolls forward until it settles. The meter only advances on a committed settlement, so a provider is never left holding unpaid seconds.",
  },
  {
    t: "Every settlement is re-derivable",
    d: "Both live paths settle with an explicit ERC-20 transfer on Arc's USDC contract, so each one emits the event the verifier sums independently.",
  },
  {
    t: "A failed settlement is never retried",
    d: "The transfer may still be in flight, so the agent closes the session on the record rather than risk paying for the same seconds twice.",
  },
];

const CAPABILITIES: [string, string][] = [
  ["Wallets on Arc", "Circle developer-controlled wallets, or a plain Arc key"],
  ["Per-second settlement", "USDC on Arc, sub-second finality"],
  ["Provable settlement", "Explicit ERC-20 transfer via Circle contract execution or viem"],
  ["Settlement cadence", "Arc stable-fee design, USDC as the gas token"],
  ["Refilling across chains", "CCTP v2 through Circle Bridge Kit, Arc domain 26"],
  ["Minting with no signer on Arc", "Circle Forwarder"],
  ["Payment envelope", "x402 and Circle Gateway"],
  ["The streaming layer", "meter402, published npm SDK"],
];

export default function Home() {
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
            <Link className="nav__hide" href="/deck">
              Deck
            </Link>
            <a className="nav__hide" href="https://github.com/Risingtell/spigot" target="_blank" rel="noreferrer">
              Repo
            </a>
            <a className="btn btn--onDark" href="#console">
              Run the agent{" "}
              <span className="arw" aria-hidden="true">
                &rarr;
              </span>
            </a>
          </nav>
        </div>
      </header>

      <main id="main">
        {/* ---------------------------------------------------------- hero */}
        <section className="hero" aria-labelledby="heroH">
          <div className="hero__grid">
            <div className="hero__copy">
              <p className="eyebrow eyebrow--onAmber">Agentic Economy &middot; Built on Arc</p>
              <h1 className="h-xl" id="heroH">
                <span className="l">The agent</span>
                <span className="l">that knows</span>
                <span className="l">when to</span>
                <span className="l">stop paying.</span>
              </h1>
              <p className="hero__sub">
                Circle built the rail. Spigot is the buyer: an agent that holds a metered service, prices every second
                against what that second is worth, and shuts its own gate the moment the answer turns. Live on two
                rails, settling real USDC on Arc.
              </p>
              <div className="hero__cta">
                <a className="btn" href="#console">
                  Run the agent{" "}
                  <span className="arw" aria-hidden="true">
                    &rarr;
                  </span>
                </a>
                <Link className="btn btn--ghost" href="/deck">
                  Read the deck
                </Link>
              </div>
              <p className="hero__loc">No subscription &middot; No human clicking pay</p>
            </div>
            <div className="hero__pat" aria-hidden="true" />
          </div>
          <SpigotMark className="hero__mark" tone="black" />
        </section>

        {/* --------------------------------------------------- fee market */}
        <section className="stats" aria-label="Arc fee market">
          <div className="pat pat--diag" aria-hidden="true" />
          <div className="wrap stats__in">
            <p className="eyebrow eyebrow--onDark">Live on two rails</p>
            <div className="stats__grid">
              <div className="rv">
                <span className="stat__n">$0.0016</span>
                <span className="stat__l">Gas per settlement on the direct Arc rail</span>
              </div>
              <div className="rv">
                <span className="stat__n">$0.00</span>
                <span className="stat__l">Gas per settlement through Circle Nanopayments</span>
              </div>
              <div className="rv">
                <span className="stat__n">1</span>
                <span className="stat__l">Agent policy, identical on both rails</span>
              </div>
              <div className="rv">
                <span className="stat__n">0</span>
                <span className="stat__l">Numbers stored by us. The public record is re-derived on request</span>
              </div>
            </div>
            <p className="stats__note">
              Settling directly on Arc costs gas, so the agent reads the live fee and batches into blocks worth
              settling. Through Circle Nanopayments the signature is off-chain and the settlement is batched by Circle,
              so it settles every tick for nothing. The economics change completely between the two; the decision logic
              does not change at all. See the live record at{" "}
              <a href="/api/impact" className="mono" style={{ color: "var(--amber)" }}>
                /api/impact
              </a>
              .
            </p>
          </div>
        </section>

        {/* ---------------------------------------------------- statement */}
        <section className="stmt" aria-labelledby="stmtH">
          <div className="pat pat--brick" aria-hidden="true" />
          <div className="wrap stmt__in">
            <div className="rv">
              <div className="stmt__rule" aria-hidden="true" />
              <blockquote id="stmtH">
                An agent with a wallet and no policy
                <em>
                  <span className="hl">is not autonomous.</span>
                </em>
                It is just unattended.
              </blockquote>
            </div>
            <div className="prose rv">
              <p>
                An agent holding a live risk feed, an inference stream, a GPU or a dataset is consuming continuously.
                Billing that as one-shot calls goes wrong in both directions: charge upfront and the agent pays for time
                it never uses, settle afterwards and the provider carries the default risk.
              </p>
              <p>
                The missing unit is time held, priced by the second and settled without anyone approving it. That only
                becomes practical on a chain where the fee for settling is denominated in the same money being settled,
                because otherwise the arithmetic never closes.
              </p>
              <p style={{ marginTop: "1.75rem" }}>
                <Link className="btn btn--ghost" href="/deck">
                  Read the deck{" "}
                  <span className="arw" aria-hidden="true">
                    &rarr;
                  </span>
                </Link>
              </p>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------- how it works */}
        <section aria-labelledby="howH">
          <div className="wrap">
            <div className="shead rv">
              <p className="eyebrow">How it works</p>
              <h2 className="h-lg" id="howH">
                Four decisions, <span className="hl">every second</span>
              </h2>
            </div>
            <div className="grid3 rv">
              {HOW.map((s) => (
                <div className="card" key={s.no}>
                  <span className="card__no">{s.no}</span>
                  <h3 className="h-sm">{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- console */}
        <section className="consoleband" id="console" aria-labelledby="consoleH">
          <div className="pat pat--diag" aria-hidden="true" />
          <div className="wrap consoleband__in">
            <div className="shead shead--onDark rv">
              <p className="eyebrow eyebrow--onDark">Live</p>
              <h2 className="h-lg" id="consoleH">
                Watch it decide
              </h2>
              <p className="lede">
                The real agent loop, running server-side against Arc&apos;s live fee market. Pick a scenario and press
                run.
              </p>
            </div>
            <div className="consoleshell rv">
              <div className="consoleshell__bar">Spigot agent console</div>
              <div className="consoleshell__body">
                <Console />
              </div>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- invariants */}
        <section className="why" aria-labelledby="invH">
          <div className="pat pat--diag" aria-hidden="true" />
          <div className="wrap why__in">
            <div className="rv">
              <p className="eyebrow eyebrow--onDark">Guarantees</p>
              <h2 className="h-lg" id="invH" style={{ color: "var(--white)" }}>
                What holds, <span className="hl">by construction</span>
              </h2>
              <p className="lede" style={{ marginTop: "1.5rem", color: "rgba(255,255,255,.78)" }}>
                Each of these is asserted by the test suite, not just claimed here.
              </p>
            </div>
            <ul className="why__list rv">
              {INVARIANTS.map((i) => (
                <li key={i.t}>
                  <b>{i.t}</b>
                  <span>{i.d}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------------------- verify */}
        <section aria-labelledby="verifyH">
          <div className="wrap">
            <div className="stmt__in">
              <div className="rv">
                <p className="eyebrow">Proof</p>
                <h2 className="h-lg" id="verifyH">
                  Do not trust us. <span className="hl">Re-derive it</span>
                </h2>
                <p className="lede" style={{ marginTop: "1.5rem" }}>
                  One command, no keys, no wallet. It reads Arc directly and sums every USDC transfer an agent made to a
                  provider, straight from the token&apos;s transfer logs.
                </p>
                <div className="codeblock" style={{ marginTop: "1.75rem" }}>
                  {`git clone https://github.com/Risingtell/spigot
npm install && npm run verify`}
                </div>
              </div>
              <div className="rv">
                <p className="eyebrow">The stack</p>
                <table className="captable">
                  <thead>
                    <tr>
                      <th>Flow</th>
                      <th>Capability</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CAPABILITIES.map(([flow, cap]) => (
                      <tr key={flow}>
                        <td>{flow}</td>
                        <td>{cap}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- cta */}
        <section className="cta" aria-labelledby="ctaH">
          <div className="pat pat--brick" aria-hidden="true" />
          <div className="wrap cta__in">
            <div className="rv">
              <p className="eyebrow eyebrow--onAmber">Open source</p>
              <h2 className="h-lg" id="ctaH">
                Built on a primitive you can use
              </h2>
              <p>
                The streaming layer underneath Spigot is meter402, published on npm under MIT. Any Arc builder can meter
                and settle by the second without rebuilding it.
              </p>
            </div>
            <div className="hero__cta rv">
              <a className="btn" href="https://github.com/Risingtell/spigot" target="_blank" rel="noreferrer">
                View the repo{" "}
                <span className="arw" aria-hidden="true">
                  &rarr;
                </span>
              </a>
              <a
                className="btn btn--ghost"
                href="https://www.npmjs.com/package/meter402"
                target="_blank"
                rel="noreferrer"
              >
                meter402 on npm
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="ftr">
        <div className="wrap">
          <div className="ftr__top">
            <div>
              <SpigotMark className="brand__mark" style={{ width: 38, height: 38, marginBottom: "1.2rem" }} />
              <p className="ftr__tag">Agent-native streaming settlement on Arc</p>
            </div>
            <div>
              <h2>Project</h2>
              <ul>
                <li>
                  <Link href="/deck">Deck</Link>
                </li>
                <li>
                  <a href="#console">Live console</a>
                </li>
                <li>
                  <a href="https://github.com/Risingtell/spigot" target="_blank" rel="noreferrer">
                    Repository
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h2>Built with</h2>
              <ul>
                <li>
                  <a href="https://docs.arc.network/" target="_blank" rel="noreferrer">
                    Arc
                  </a>
                </li>
                <li>
                  <a href="https://developers.circle.com/" target="_blank" rel="noreferrer">
                    Circle developer platform
                  </a>
                </li>
                <li>
                  <a href="https://www.npmjs.com/package/meter402" target="_blank" rel="noreferrer">
                    meter402
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="ftr__bot">
            <span>Rising Technology</span>
            <span>Programmable Money Hackathon &middot; Agentic Economy</span>
          </div>
        </div>
      </footer>
    </>
  );
}
