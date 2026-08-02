# Judge quickstart

Five minutes, no keys, no wallet, no signup. Three ways in, shortest first.

## 1. Click it (30 seconds)

**[spigot-taupe.vercel.app](https://spigot-taupe.vercel.app)**

The panel at the top of the console is Arc's fee market, read live from the public
RPC when the page loads. It shows what one settlement costs right now and how
often that makes settling worthwhile at three different stream prices.

Pick a rail first. **Direct on Arc** broadcasts a transaction per settlement, so
the agent batches until the chain fee is a rounding error. **Gas free** signs
off-chain and lets Circle Gateway batch it, so the agent buys every tick for
nothing and the response to each payment is the next chunk of the feed. Same
agent, same budget, same value signal on both.

On the gas-free rail the default is **Live market signal**: the agent measures BTC
trade flow for four seconds, holds the feed to whatever it measured, and stops when
flow falls away. How many blocks it buys therefore depends on what the market is
doing when you click, which is the product working rather than a script running.

Press **Run the agent**. Each scenario runs the real agent loop server-side:

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

This is the load-bearing command. It needs no keys and no configuration. It:

1. calls `eth_chainId`, `eth_blockNumber` and `eth_gasPrice` against
   `https://rpc.testnet.arc.network`;
2. prices one USDC transfer at that gas price and derives the settlement cadence;
3. sums every USDC transfer Spigot's agent made to its provider, straight from the
   token's `Transfer` logs, over the full history from the first settlement to the
   current head.

**It takes about two minutes and prints progress while it runs.** Arc caps a log
query at 10,000 blocks and throttles the calls, so step 3 is 59 sequential windows
and climbing. It waits the throttle out rather than failing, and if a window still
cannot be read it says so and calls the total a floor instead of quietly reporting
a short count.

Every number it prints comes from Arc. Nothing is read from a Spigot server or
database. Cross-check the gas price against
[testnet.arcscan.app](https://testnet.arcscan.app) if you want a second source.

Expected shape of the output. The gas price moves; the settlement count and total
should match exactly:

```
Fee market
  chain id:          5042002 (Arc Testnet)
  gas price:         23.0000 gwei  (live)
  one settlement:    $0.001495 at 65000 gas
  economical floor:  $0.029900 to keep the chain fee under 5%
  cadence:           settle about every 30s on a $0.001/sec stream

Settlements
  agent:             0x201EE872d4b1a3c06589032F682004a09ddB6aBA
  settlements:       16
  total settled:     $1.515800
    excluded, not a settlement: 1 transfer(s) to Circle Gateway deposit, $2.000000
  chain fee share:   1.58% of each settlement
```

That excluded line is the point of the whole project in one row: the $2 that
funded the Gateway balance is also a transfer out of the agent, and counting it as
revenue is exactly the overclaim this build exists to refuse.

## 3. Watch an agent run end to end (1 minute)

```bash
npm run demo
```

An agent holds inference capacity priced at $0.05/sec with a $0.60 budget. It
rules on roughly a dozen intervals, settles three or four times, and stops itself when
the value of the next slice drops below its cost. The closing lines show what the
chain fee actually took, and the meter402 impact snapshot, which never claims more
than it settled.

```bash
npm test
```

28 tests over the rules that move money: unit conversion between Arc's 18-decimal
gas view and the 6-decimal billing view, the economical settlement floor, the
budget invariant, the guarantee that a provider is never left holding unpaid
delivered time, the refusal to retry a settlement that may still be in flight, the
treasury rules including that a draw is fundable from the agent's balance across
chains when no single chain holds enough, and the value signal's own calibration,
including that a dead market cannot set itself a bar of zero and then clear it.

## What to look at in the code

| Question | File |
| --- | --- |
| How does the agent decide, and when does it settle? | [`src/agent.ts`](./src/agent.ts) |
| Where does the settlement cost come from? | [`src/arc-gas.ts`](./src/arc-gas.ts) |
| How does a block become real USDC on Arc? | [`src/arc-eoa.ts`](./src/arc-eoa.ts), [`src/circle-wallet.ts`](./src/circle-wallet.ts) |
| How does the agent hold one balance across chains, and refill Arc from it? | [`src/treasury.ts`](./src/treasury.ts) |
| How is any of this checkable? | [`src/verify.ts`](./src/verify.ts) |

## The one-line version

x402 pays per request. Spigot pays per second, and is the first version of that
idea that does the arithmetic on what settling actually costs - which only works
on a chain where gas is the same stablecoin as the payment.
