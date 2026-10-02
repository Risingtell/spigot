/**
 * The floors the hosted console will not spend through, in one place.
 *
 * These numbers are read twice: once by `/api/run`, which decides whether a click
 * settles real USDC or runs against a mock, and once by `/api/treasury`, which
 * tells the page which of those two is about to happen before anybody clicks.
 *
 * They were duplicated, and a badge that promises a live run while the route
 * quietly runs a simulated one is worse than no badge at all - it turns an honest
 * fallback into a false claim. So both sides import the same constants, and the
 * only way they can disagree now is if someone edits this file and means to.
 */

/** Below this on-chain balance the direct rail stops settling for real. */
export const DIRECT_RESERVE_UNITS = 500_000n; // $0.50

/** Below this Gateway balance the gas-free rail stops settling for real. */
export const GATEWAY_RESERVE_UNITS = 200_000n; // $0.20
