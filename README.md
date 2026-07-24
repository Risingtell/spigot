# Spigot

**Agent-native streaming settlement on Arc.** Autonomous agents pay per second in
USDC for exactly the service-time they hold, and shut their own gate the moment
the next second stops being worth paying for.

> Status: work in progress for the Encode x Arc Programmable Money Hackathon
> (Agentic Economy track). The core streaming-settlement loop runs end to end
> today; the live Arc settlement path is wired and typechecks; the hosted MVP,
> on-chain verifier, and demo video land for the final submission.

Built on [meter402](https://github.com/Risingtell/meter402), the open-source
per-second settlement primitive this project consumes as a published npm package.

## The problem

x402 is a per-*request* payment standard: one call, one payment. But agents
increasingly consume things *continuously* - a live risk feed, an inference
stream, a GPU, a dataset. Charging that as one-shot 402 calls either over-charges
(pay upfront for time you never use) or under-charges (settle after the fact and
eat the default risk). And a human clicking "pay" defeats the point of an
autonomous agent.

Arc makes the missing model practical: USDC is the native gas token and
settlement is sub-second, so paying by the *second* is real, not theoretical.

## What Spigot does

An agent opens a session against a metered stream, then runs a tick loop it
governs itself:

```
open session ──▶ quote next tick ──▶ worth it?  ──yes──▶ settle on Arc ──▶ commit + get next chunk
                       ▲                  │                                          │
                       │                  └──no──▶ close the gate, record why        │
                       └──────────────────  agent decides, every tick  ──────────────┘
```

Every "keep paying" is a **real USDC transfer on Arc**, wallet to wallet, agent
to provider. Every "stop" is a recorded decision with a reason - budget
exhausted, rate above ceiling, or the marginal value of the next chunk fell below
its price. The agent never spends past its own budget and never pays for a second
it did not want.

## Real agent autonomy, not an AI wrapper

The agent carries a policy - a hard USDC budget, a maximum acceptable rate per
second, and an objective - and a value signal: what the *next* chunk is worth to
it right now, tied to a real input (data freshness, model confidence, an
arbitrage edge). Each tick it weighs that value against the tick's cost and its
remaining budget, and decides. When the edge decays below the price, it stops on
its own. See [`src/agent.ts`](./src/agent.ts).

## Run it (no keys, no chain)

```bash
npm install
npm run demo
```

You will see an agent stream a BTC risk feed, pay a few per-second ticks, then
close its own gate when the feed's edge drops below what the next second costs -
with a full proof snapshot that never claims more than it settled.

## Going live on Arc

Swap `MockSettlementProvider` for `ArcSettlementProvider` and the same loop
becomes real money on Arc, unchanged. Each tick moves USDC from the agent's
Circle developer-controlled wallet to the provider and records the confirmed
on-chain tx hash. Configure `.env.local` (see [`src/run-live.ts`](./src/run-live.ts)):

```
CIRCLE_API_KEY=...
CIRCLE_ENTITY_SECRET=...
CIRCLE_WALLET_SET_ID=...
SPIGOT_AGENT_WALLET_ID=...     # the agent's funded Circle wallet on Arc
SPIGOT_PROVIDER_ADDRESS=0x...  # provider receives settlement here
```

```bash
npm run agent
```

## Capability map (Arc + Circle stack)

| Spigot flow | Arc / Circle capability |
| --- | --- |
| Agent + provider wallets on Arc | Circle developer-controlled wallets (`ARC-TESTNET`) |
| Per-second USDC settlement, wallet to wallet | USDC on Arc, sub-second finality |
| Per-request payment envelope under each tick | x402 / Circle Gateway (`eip155:5042002`) |
| Per-second streaming layer over x402 | meter402 (published npm SDK) |
| Proof feed that never over-claims | meter402 impact snapshot |

Landing next for the final submission: **CCTP** cross-chain auto top-up when an
agent runs low, **Paymaster** for gasless agent settlement, **App Kits**
(Send / Swap / Unified Balance) on the treasury side, an on-chain verifier that
re-derives every total straight from Arc, and a hosted MVP with a demo video.

## Architecture

```
meter402 (npm)              Spigot
─────────────              ────────────────────────────────────────
StreamingMeter    ◀──────  StreamingAgent   policy + value signal, the tick loop
SettlementProvider ◀─────  ArcSettlementProvider   settles a tick via Circle on Arc
                           circle-wallet.ts   Circle wallets, payAndConfirm on Arc
                           arc.ts             Arc Testnet constants + USDC units
impact snapshot   ──────▶  proof feed / (verifier, next)
```

The settlement primitive lives in meter402 so it is reusable by any Arc builder;
Spigot is the agent, the policy, and the Arc binding on top.

## Tech stack

TypeScript, [meter402](https://www.npmjs.com/package/meter402),
`@circle-fin/developer-controlled-wallets`, Arc Testnet, USDC.

## License

MIT © Oluwasogo "Israel" Ajala (Rising Technology)
