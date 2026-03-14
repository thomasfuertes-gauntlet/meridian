/**
 * Shared constants for Meridian scripts.
 * Single source of truth - import from here, not local redefinitions.
 */

export const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
export type Mag7Ticker = typeof MAG7_TICKERS[number];

export const USDC_DECIMALS = 6;
export const USDC_PER_PAIR = 1_000_000; // 1 USDC = 10^6 base units

// Pyth Hermes feed IDs - canonical source is scripts/pyth.ts
export { PYTH_FEED_IDS } from "./pyth";
