# Judge quickstart

Five minutes, no keys, no wallet, no signup. Three ways in, shortest first.

## 1. Click it (30 seconds)

**[spigot-taupe.vercel.app](https://spigot-taupe.vercel.app)**

The panel at the top of the console is Arc's fee market, read live from the public
RPC when the page loads. It shows what one settlement costs right now and how
often that makes settling worthwhile at three different stream prices.

Press **Run the agent** on any of the three scenarios. Each one runs the real agent
loop server-side against that live fee reading:

| Scenario | What it shows |
| --- | --- |
| Queue drains | The agent decides the next slice is not worth its price and closes its own gate early |
| Work keeps coming | It holds longer, settling several times as the amount owed clears the fee threshold |
| Tight budget | It stops at the hard budget it was given, even though the stream is still valuable |

Watch the counters: the agent rules on far more intervals than it settles, and the
fee share stays under the 5% ceiling on every settlement, the last one included. The
page states which mode each run used - live confirmed transfers on Arc when the
deployment holds a key, with every hash linking to the explorer, or a simulated
provider when it does not.

## 2. Verify the claim yourself (2 minutes)

```bash
git clone https://github.com/Risingtell/spigot && cd spigot
npm install
npm run verify
```

This is the load-bearing command. It:

1. calls `eth_chainId`, `eth_blockNumber` and `eth_gasPrice` against
   `https://rpc.testnet.arc.network`;
2. prices one USDC transfer at that gas price and derives the settlement cadence;
3. given `SPIGOT_AGENT_ADDRESS`, sums every USDC transfer that agent made to a
   provider, straight from the token's `Transfer` logs.

Every number it prints comes from Arc. Nothing is read from a Spigot server or
database. Cross-check the gas price against
[testnet.arcscan.app](https://testnet.arcscan.app) if you want a second source.

Expected shape of the output:

```
Fee market
  chain id:          5042002 (Arc Testnet)
  gas price:         24.0563 gwei  (live)
  one settlement:    $0.001564 at 65000 gas
  economical floor:  $0.031280 to keep the chain fee under 5%
  cadence:           settle about every 31s on a $0.001/sec stream
```

## 3. Watch an agent run end to end (1 minute)

```bash
npm run demo
```

An agent holds inference capacity priced at $0.05/sec with a $0.60 budget. It
rules on roughly ten intervals, settles about three times, and stops itself when
the value of the next slice drops below its cost. The closing lines show what the
chain fee actually took, and the meter402 impact snapshot, which never claims more
than it settled.

```bash
npm test
```

21 tests over the rules that move money: unit conversion between Arc's 18-decimal
gas view and the 6-decimal billing view, the economical settlement floor, the
budget invariant, the guarantee that a provider is never left holding unpaid
delivered time, the refusal to retry a settlement that may still be in flight, and
the treasury top-up rule.

## What to look at in the code

| Question | File |
| --- | --- |
| How does the agent decide, and when does it settle? | [`src/agent.ts`](./src/agent.ts) |
| Where does the settlement cost come from? | [`src/arc-gas.ts`](./src/arc-gas.ts) |
| How does a block become real USDC on Arc? | [`src/arc-eoa.ts`](./src/arc-eoa.ts), [`src/circle-wallet.ts`](./src/circle-wallet.ts) |
| How does the agent refill itself across chains? | [`src/treasury.ts`](./src/treasury.ts) |
| How is any of this checkable? | [`src/verify.ts`](./src/verify.ts) |

## The one-line version

x402 pays per request. Spigot pays per second, and is the first version of that
idea that does the arithmetic on what settling actually costs - which only works
on a chain where gas is the same stablecoin as the payment.
