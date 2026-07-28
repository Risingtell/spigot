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
| Settled on-chain | real USDC transfers, re-derivable from the token ledger |
| Chain fee share | 1.14% of each settlement on the live runs, against a 5% ceiling |
| Settlement cadence | derived from the live fee market, not hardcoded |
| Verification | `npm run verify` re-derives everything from Arc, no keys, no config |
| Tests | 21 passing over the rules that move money |
| SDK | built on [meter402](https://www.npmjs.com/package/meter402), published on npm |

Run `npm run verify` on a fresh clone and it will re-derive Spigot's own settlements
straight from Arc, with nothing configured. The totals it prints are not read from
this repo or from any server we control.

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
now Arc quotes around 24 gwei, so one USDC transfer costs about **$0.0016**. A
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

It also keeps itself funded. A streaming agent has a failure mode a per-request
agent does not: running dry mid-stream, while holding something it is paying for
by the second. When its Arc balance falls below its floor, it bridges USDC in from
a reserve on another chain over CCTP, using Circle's Bridge Kit, with the
Forwarder submitting the mint so it needs no signer on Arc at all. See
[`src/treasury.ts`](./src/treasury.ts).

## Run it

No keys, no wallet, no chain writes:

```bash
npm install
npm run demo      # an agent holds a stream, batches settlement, stops itself
npm run verify    # re-derive the fee market and any settled totals from Arc
npm test          # 21 tests over the rules that move money
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

```bash
npm run topup     # check the Arc balance, bridge in from the reserve chain
```

## Capability map

| Spigot flow | Arc / Circle capability |
| --- | --- |
| Agent and provider wallets on Arc | Circle developer-controlled wallets (`ARC-TESTNET`), or a plain Arc key |
| Per-second USDC settlement, wallet to wallet | USDC on Arc, sub-second finality |
| Settlement as an explicit ERC-20 call, so it is provable | Circle contract execution, viem on Arc |
| Settlement cadence priced from the fee market | Arc's stable-fee design, USDC as gas token |
| Agent refills its own Arc wallet across chains | CCTP v2 via Circle Bridge Kit, Arc domain 26 |
| Mint on Arc without a signer there | Circle Forwarder (Orbit relayer) |
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
                           treasury.ts       CCTP top-up via Bridge Kit
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

## Tech stack

TypeScript, [meter402](https://www.npmjs.com/package/meter402),
`@circle-fin/developer-controlled-wallets`, `@circle-fin/bridge-kit`,
`@circle-fin/adapter-viem-v2`, Next.js, Arc Testnet, USDC.

## License

MIT © Oluwasogo "Israel" Ajala (Rising Technology)
