# Contributing

## Running it

```bash
npm install
npm test          # 28 tests over the rules that move money
npm run demo      # an agent holds a stream, batches settlement, stops itself
npm run verify    # re-derive the settled totals from Arc, no keys needed
npm run typecheck
```

Node 18 or newer. Nothing above needs a key, a wallet or a signup.

## The rules this codebase holds itself to

These are not style preferences. Each one exists because breaking it lost money,
or would have.

- **Produce the deliverable before taking payment.** A provider that cannot
  deliver does not get paid, and the buyer keeps an unused authorisation.
- **Never retry a payment or a settlement.** A call that failed after the
  counterparty settled has lost only the response, so retrying charges twice.
  Retry reads as much as you like: a read cannot double-spend.
- **Never claim a number the chain does not show.** Figures come from a ledger we
  do not control, fetched on request. If a total cannot be fully derived, report
  it as a floor and say so.
- **Retries cannot fix a concurrency cap.** Arc's public RPC limits calls in
  flight, not calls made. Route through the paced transport in `src/chain.ts`.
- **Relative imports are extensionless.** Turbopack will not resolve `./x.js` to
  a `.ts` file.

## Pull requests

Keep `npm test`, `npm run typecheck` and `npm run build` green. If you change
anything that decides whether money moves, add a test named after the claim it
defends rather than after the function it calls.
