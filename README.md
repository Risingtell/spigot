# Spigot

**Agent-native streaming settlement on Arc.** An autonomous agent holds a metered
service, prices every second of it against what that second is worth, settles in
USDC on the cadence Arc's own fee market allows, and shuts its own gate the moment
the answer turns.

**[Live demo](https://spigot-taupe.vercel.app)** ·
**[Repo](https://github.com/Risingtell/spigot)** ·
Encode x Arc Programmable Money Hackathon, Agentic Economy track

| | |
| --- | --- |
| Chain | Arc Testnet (5042002), USDC as the gas token |
| Settled on the direct rail | **19 settlements, $1.6985 USDC**, every one a `Transfer` in Arc's token ledger |
| Settled gas free | **4 settlements, $0.3997 USDC** through Circle Nanopayments, signed off-chain and batched by Circle |
| Both rails together | **23 settlements, $2.0981 USDC** at the time of writing, and climbing every time somebody runs the hosted console live |
| Chain fee share | Held under a **5% ceiling on every settlement**, including the last one. `npm run verify` recomputes what it actually was |
| Settlement cadence | derived from the live fee market, not hardcoded |
| Verification | `npm run verify` re-derives everything from Arc, no keys, no config |
| Tests | **24 passing**, over the rules that move money |
| SDK | built on [meter402](https://www.npmjs.com/package/meter402), published on npm |

Those numbers are a floor, not a boast, and they are the wrong way round on purpose:
the hosted console settles for real, so the count above goes up on its own and the
figure here goes stale downwards rather than upwards. The live one is at
[`/api/impact`](https://spigot-taupe.vercel.app/api/impact) and the authoritative one
comes from the chain:

Run `npm run verify` on a fresh clone and it will re-derive Spigot's own settlements
straight from Arc, with nothing configured. The totals it prints are not read from
this repo or from any server we control. It walks 59 windows of Arc's log index and
takes roughly two minutes, printing progress as it goes.

Built on [meter402](https://github.com/Risingtell/meter402), the open-source
per-second settlement primitive this project consumes as a published npm package.

## The problem, and the part everyone skips

x402 is a per-*request* standard: one call, one payment. Agents increasingly
consume things *continuously* instead - a live risk feed, an inference stream, a
GPU, a dataset. Charging that as one-shot calls either over-charges (pay upfront
for time you never use) or under-charges (settle afterwards and eat the default
risk). And a human clicking "pay" defeats the point of an autonomous agent.

The obvious answer is to settle every second. On most chains that is absurd,
because gas is a separate volatile asset worth more than the payment. Arc removes
half of that problem: USDC *is* the gas token, so the fee and the payment are the
same asset and directly comparable.

It does not remove the other half, and this is the part a demo usually hides. Right
now Arc quotes around 25 gwei, so one USDC transfer costs roughly **$0.0016**. A
market-data feed at $0.001/sec would hand the chain **more than the provider
earns** if it settled every second.

So Spigot separates two cadences that naive per-second billing conflates:

- **it decides every second**, because that is how often the value of the next
  second changes;
- **it settles when the amount owed makes the fee a rounding error**, reading
  Arc's live gas price to work out when that is.

At a 5% overhead ceiling, that is a settlement roughly every 31s on a $0.001/sec
feed, every 0.6s on $0.05/sec inference capacity, and every 0.06s on a $0.50/sec
GPU. The agent computes this itself, live, per stream.

That amount is therefore also the smallest **block** of time worth opening, and the
agent treats it as one. Opening a block commits it to paying for the whole block, so
it only opens one it can afford outright, and it always stops on a boundary. If the
stream stops earning its price partway through, the agent stops buying immediately
and rides out what it already committed to, rather than walking away from time the
provider delivered. That is what keeps the fee inside the ceiling on every
settlement, including the last one.

## What the agent actually decides

```
open a block ──▶ meter the interval ──▶ worth the next slice? ──no──▶ stop buying
     ▲                   ▲                        │yes                    │
     │                   │                        ▼                       │
     │                   │              block complete? ──no──────────────┤
     │                   └──── roll forward ──────┘yes                    │
     │                                            ▼                       │
     └──── still buying ◀── settle the block on Arc ──▶ stopping? ────────┘
                                                            │yes
                                                            ▼
                                                  close, record why
```

The agent carries a policy - a hard USDC budget, a maximum acceptable rate per
second, an objective, and an overhead ceiling - plus a value signal: what the
*next* slice is worth to it right now, tied to a real input. Every stop is a
recorded decision with a reason: budget exhausted, rate above ceiling, or the
marginal value of the next slice fell below its price. See
[`src/agent.ts`](./src/agent.ts).

It also keeps itself funded, and this is where the budget stops being a number on
one chain. A streaming agent has a failure mode a per-request agent does not:
running dry mid-stream, while holding something it is paying for by the second.

The obvious answer is a reserve on a named chain and a bridge to move it. That
makes the agent do treasury management, picking a source and a moment, and it
means a budget spread over six chains is six budgets rather than one. Circle's
**Unified Balance Kit** removes the question. The agent deposits USDC into Gateway
on whatever chains it holds funds on, and from then on it has a single balance.
When Arc runs low, `spend()` chooses the source chains itself, destination first
and Ethereum last, builds one burn intent per source, batch-signs them over
EIP-712, and mints on Arc through the Forwarder so the agent needs no gas and no
signer there at all.

It needs no Circle organisation, no API key and no entity secret: the kit
authenticates through the adapter, so the key that settles is the key that moves
the reserve. See [`src/treasury.ts`](./src/treasury.ts).

```bash
npm run topup                  # read the balance, draw only if the policy says so
npm run topup -- --fund 5      # move USDC into the unified balance
npm run topup -- --draw 2      # exercise a draw on demand
```

## Run it

No keys, no wallet, no chain writes:

```bash
npm install
npm run demo      # an agent holds a stream, batches settlement, stops itself
npm run verify    # re-derive the fee market and any settled totals from Arc
npm test          # 24 tests over the rules that move money
```

`npm run verify` is the one to read closely. It takes Arc's gas price live, prices
one settlement, derives the cadence, and - given an agent address - sums every USDC
transfer that agent made to a provider straight from the token's `Transfer` logs.
None of it comes from Spigot.

To settle for real, the agent needs USDC on Arc. The quick way is a plain key,
funded from [faucet.circle.com](https://faucet.circle.com):

```bash
SPIGOT_ARC_KEY=0x...            # a key holding USDC on Arc
SPIGOT_PROVIDER_ADDRESS=0x...   # who gets paid
npm run agent                   # same loop, real confirmed transfers
```

Circle developer-controlled wallets work the same way, with
`CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET` / `CIRCLE_WALLET_SET_ID` and
`SPIGOT_AGENT_WALLET_ID` instead of the key. Either path settles through an
explicit ERC-20 `transfer` call, so `npm run verify` can re-derive it. See
[`.env.example`](./.env.example). The hosted console settles live too whenever the
deployment holds a key, behind a spend cap and a rate limit, and labels which mode
each run used.

### The gas-free rail

The direct path above broadcasts a transaction per settlement, which is why the
agent batches blocks up to roughly three cents before settling is worth the gas.
Circle Nanopayments removes that constraint entirely: the agent signs off-chain,
Gateway credits the provider instantly, and Circle batches the on-chain settlement
across thousands of payments.

```bash
npm run dev       # the provider: an x402-gated metered stream
npm run nano      # the agent: deposits into Gateway, then buys blocks gas free
```

Same agent, same policy, different rail. On this one it settles every tick at a
fraction of a cent, and the response body to each payment **is** the next chunk of
the stream, so the gate is the payment rather than something layered on top of it.

The value signal is real market data. The agent watches BTC trade flow from the
Coinbase exchange ticker and keeps buying only while the market is active enough
to be worth the price. Spot price turned out to be useless at this cadence, with
eight of nine one-second samples unchanged, so the agent rules on trades per
second instead, taken from the ticker's monotonic trade id.

## Capability map

| Spigot flow | Arc / Circle capability |
| --- | --- |
| Agent and provider wallets on Arc | Circle developer-controlled wallets (`ARC-TESTNET`), or a plain Arc key |
| Gas-free sub-cent settlement | Circle Nanopayments over Gateway, `@circle-fin/x402-batching` |
| Selling a metered stream to an agent | x402 402 challenge priced per block, settled by `BatchFacilitatorClient` |
| The agent's decision input | live BTC trade flow, Coinbase exchange ticker |
| Per-second USDC settlement, wallet to wallet | USDC on Arc, sub-second finality |
| Settlement as an explicit ERC-20 call, so it is provable | Circle contract execution, viem on Arc |
| Settlement cadence priced from the fee market | Arc's stable-fee design, USDC as gas token |
| One USDC balance across every chain the agent holds | Circle Unified Balance Kit, Gateway v1 |
| Choosing which chains to draw a top-up from | `spend()` auto-allocation, burn intents batch-signed over EIP-712 |
| Mint on Arc without a signer or gas there | Circle Forwarder |
| Per-request payment envelope under each settlement | x402 / Circle Gateway (`eip155:5042002`) |
| Per-second streaming layer over x402 | meter402, published npm SDK |
| Proof feed that never over-claims | meter402 impact snapshot plus on-chain verifier |

## Architecture

```
meter402 (npm)              Spigot
─────────────              ────────────────────────────────────────
StreamingMeter    ◀──────  StreamingAgent    policy, value signal, the decision loop
SettlementProvider ◀─────  ArcSettlementProvider   settles via Circle on Arc
createEvmVerifier ◀──────  verify.ts         re-derives totals from Arc logs
                           arc-gas.ts        live fee market, settlement economics
                           treasury.ts       one balance across chains, drawn onto Arc
                           circle-wallet.ts  Circle wallets, ERC-20 transfer on Arc
                           arc-eoa.ts        the same settlement from a plain key
                           arc.ts            Arc constants, 18dp gas to 6dp billing
```

The settlement primitive lives in meter402 so any Arc builder can reuse it; Spigot
is the agent, the policy, the economics, and the Arc binding on top.

## The invariants

These hold by construction, and the test suite asserts each one:

- **Every settlement clears the economical floor.** The amount worth settling is
  also the smallest block of time worth opening, so the agent only opens a block it
  can pay for outright and always stops on a block boundary. If a stream stops
  earning its price partway through a block, the agent stops buying at once and
  rides out what it already committed to. There is no closing fragment, so the
  overhead ceiling holds on the last settlement as well as the first.
- **The budget cannot be breached.** A block is only opened if the whole block fits
  inside what is left. An agent whose budget cannot fund even one worthwhile
  settlement declines before consuming anything, rather than running up a debt.
- **A provider is never left holding unpaid delivered time.** Metered time rolls
  forward until it is settled; the meter only advances on a committed settlement.
- **Every settlement is re-derivable from the chain.** Both live paths settle with
  an explicit `transfer(address,uint256)` call on Arc's USDC contract, so each one
  emits the `Transfer` event that `npm run verify` sums independently.
- **A failed settlement is never retried.** The transfer may still be in flight, so
  the agent closes the session on the record instead of risking paying twice.
- **Nothing is ever claimed that the chain does not show.** Spend is only booked on
  a confirmed settlement, and the impact snapshot is built from settled events.

## What is honestly not production-grade yet

Testnet only, and deliberately so: Arc mainnet is not open and the point of the
build is the buyer-side policy, not custody. Beyond that:

- **The hosted console's spend guards are per instance.** A rate limit and an
  in-flight lock held in module state reset on a cold start, so the only cap that
  genuinely holds across instances is the agent's own on-chain balance, which is
  why live settlement simply stops being offered below a reserve. Said plainly in
  [`app/api/run/route.ts`](./app/api/run/route.ts) rather than dressed up.
- **The public record reads a bounded window.** Arc caps a log query at 10,000
  blocks and produces about 130,000 a day, so no request-time scan can cover the
  chain. The feed scans a fixed window anchored at the first settlement and names
  the blocks it covered; `npm run verify` is the one that scans to the head.
- **Sixteen deep transitive advisories remain open**, all inside Circle's own
  SDKs (`@solana/web3.js`, `@ethersproject/*`, `@coral-xyz/anchor`) with no fix
  published upstream. Every high-severity one is closed, by pinning `postcss` and
  `sharp` through `overrides` rather than downgrading the framework.
- **The value signal is one feed.** Trade flow from one exchange ticker drives the
  decision. It is real and it was measured before being trusted, but it is a
  single source, and a production buyer would want more than one.
- **The unified balance currently sits on one chain.** Every part of the treasury
  is live and exercised on Arc, and auto-allocation reports the chains it drew
  from, but a draw that spans two chains at once has not been run yet. Depositing
  from another chain needs that chain's own gas token, which is the one thing Arc
  removes and nowhere else does.

## Tech stack

TypeScript, [meter402](https://www.npmjs.com/package/meter402),
`@circle-fin/developer-controlled-wallets`, `@circle-fin/unified-balance-kit`,
`@circle-fin/adapter-viem-v2`, Next.js, Arc Testnet, USDC.

## License

MIT © Oluwasogo "Israel" Ajala (Rising Technology)
