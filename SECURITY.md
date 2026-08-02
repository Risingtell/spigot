# Security

Spigot moves real USDC, on testnet today and on the same code paths that would
move it anywhere else. Security reports are welcome and will be answered.

## Reporting

Open a [private security advisory](https://github.com/Risingtell/spigot/security/advisories/new),
or email the maintainer at risingtell@gmail.com. Please do not open a public issue
for anything that could be used to move funds.

Expect an acknowledgement within 72 hours.

## Scope

In scope, and most interesting to us:

- anything that lets a payer be charged twice for the same block of stream time
- anything that lets the agent exceed its stated budget or rate ceiling
- anything that lets a provider be paid without delivering, or deliver without
  being paid
- anything that makes the public record at `/api/impact` claim more than the
  chain and Circle's Gateway API can back

Out of scope: the throughput limits of Arc's public RPC, and the fact that the
hosted console's per-instance rate limit resets on a cold start. Both are known,
documented in the README, and bounded by the agent's on-chain balance rather than
by that counter.

## Keys

No private key is ever committed. `.env` and `.env.local` are gitignored and the
tree is secret-scanned before publishing. The agent's address is public on
purpose, so anyone can re-derive its settlements: `npm run verify`.
