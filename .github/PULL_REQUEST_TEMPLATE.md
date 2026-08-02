## What this changes

<!-- One or two sentences. What is different afterwards? -->

## Why

<!-- What went wrong, or what was missing. If this is a bug fix, what was the
     failure and how was it observed? -->

## Does it touch anything that moves money?

- [ ] No
- [ ] Yes, and there is a test named after the claim it defends

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] No key, secret or `.env` file is included
- [ ] Any number quoted in the docs can still be re-derived by `npm run verify`
