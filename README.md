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
| Settlement cost, measured live | about $0.0016 per transfer at 24 gwei |
| Settlement cadence | derived from that fee, not hardcoded |
| Verification | `npm run verify` re-derives everything from Arc, no keys |
| Tests | 18 passing over the rules that move money |
| SDK | built on [meter402](https://www.npmjs.com/package/meter402), published on npm |

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
GPU. The agent computes this itself, live, per stream. Nothing is lost in between:
the meter only advances when a settlement commits, so unsettled time rolls forward
and is paid off before the gate shuts.

## What the agent actually decides

```
open session ──▶ meter the interval ──▶ worth holding? ──no──▶ pay what is owed, close, record why
                        ▲                      │yes
                        │                      ▼
                        │             worth a chain fee yet?
                        │                 │no        │yes
                        └── roll forward ─┘          ▼
                                            settle on Arc, commit, continue
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
npm test          # 18 tests over the rules that move money
```

`npm run verify` is the one to read closely. It takes Arc's gas price live, prices
one settlement, derives the cadence, and - given an agent address - sums every USDC
transfer that agent made to a provider straight from the token's `Transfer` logs.
None of it comes from Spigot.

Live settlement on Arc, once Circle credentials and a funded wallet are in place
(see [`.env.example`](./.env.example)):

```bash
npm run agent     # same loop, real confirmed USDC transfers on Arc
npm run topup     # check the Arc balance, bridge in from the reserve chain
```

## Capability map

| Spigot flow | Arc / Circle capability |
| --- | --- |
| Agent and provider wallets on Arc | Circle developer-controlled wallets (`ARC-TESTNET`) |
| Per-second USDC settlement, wallet to wallet | USDC on Arc, sub-second finality |
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
                           circle-wallet.ts  Circle wallets, payAndConfirm on Arc
                           arc.ts            Arc constants, 18dp gas to 6dp billing
```

The settlement primitive lives in meter402 so any Arc builder can reuse it; Spigot
is the agent, the policy, the economics, and the Arc binding on top.

## Where this is honest about itself

- **The hosted demo simulates settlement.** It holds no keys. The agent loop and
  the fee market on that page are real; the transfers are not. The same loop
  settles real USDC through `npm run agent`.
- **The closing settlement can sit under the overhead ceiling.** When an agent
  stops, it pays off whatever time it already held, even if that amount is small
  against the fee. Leaving the provider unpaid for delivered seconds would be the
  worse trade.
- **The verifier reads ERC-20 `Transfer` logs.** That is what a standard USDC
  transfer emits on Arc. The first live settlement should be confirmed to appear
  in `npm run verify` before any settled total is quoted publicly.
- **Testnet only.** Arc mainnet is not available yet.
- **The gas figure is a live measurement, not a promise.** It moves with the fee
  market, which is the entire reason the agent reads it instead of assuming it.

## Tech stack

TypeScript, [meter402](https://www.npmjs.com/package/meter402),
`@circle-fin/developer-controlled-wallets`, `@circle-fin/bridge-kit`,
`@circle-fin/adapter-viem-v2`, Next.js, Arc Testnet, USDC.

## License

MIT © Oluwasogo "Israel" Ajala (Rising Technology)
