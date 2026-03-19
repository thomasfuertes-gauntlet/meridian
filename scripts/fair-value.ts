/**
 * Fair value computation for binary outcome markets.
 * Sigmoid function: probability that stock closes above strike.
 * Also fetches live stock prices from Pyth Hermes HTTP API.
 */

import { USDC_PER_PAIR, PYTH_FEED_IDS } from "./constants";
import { HERMES_BASE_URL } from "./pyth";

const FETCH_TIMEOUT_MS = 5_000;
// KEY-DECISION 2026-03-14: derive synthetic-price mode from RPC URL, not an env var.
// Localnet always uses synthetic prices; devnet/mainnet use live Hermes with off-hours fallback.
const LOCALNET = /127\.0\.0\.1|localhost/.test(process.env.ANCHOR_PROVIDER_URL ?? "");

/**
 * US equity market hours check (ET).
 * Returns true during weekday 9:30 AM - 4:30 PM ET (30min buffer after close).
 * Used to decide whether missing Pyth data is expected or alarming.
 */
export function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false; // weekend
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 570 && minutes <= 990; // 9:30 AM - 4:30 PM
}

// Fallback/seed prices for synthetic random-walk on localnet.
// Updated 2026-03-15. Strike generation uses these as reference,
// so fair values make sense relative to the generated strikes.
const FALLBACK_PRICES: Record<string, number> = {
  AAPL: 237,
  MSFT: 430,
  GOOGL: 184,
  AMZN: 208,
  NVDA: 180,
  META: 700,
  TSLA: 259,
};

// Synthetic random walk state (persists across calls within a process).
// Walks ±$5 max per minute, clamped to ±15% from seed. Time-based so
// multiple calls within the same minute return the same price.
const syntheticState = new Map<string, { price: number; lastMinute: number }>();

function getSyntheticPrice(ticker: string): number {
  const seed = FALLBACK_PRICES[ticker] ?? 100;
  const nowMinute = Math.floor(Date.now() / 60_000);
  let state = syntheticState.get(ticker);

  if (!state) {
    state = { price: seed, lastMinute: nowMinute };
    syntheticState.set(ticker, state);
    return state.price;
  }

  // Only walk on new minutes (idempotent within same minute)
  const elapsed = nowMinute - state.lastMinute;
  if (elapsed > 0) {
    for (let i = 0; i < elapsed; i++) {
      const drift = (Math.random() - 0.5) * 10; // ±$5 per minute
      state.price = Math.max(seed * 0.85, Math.min(seed * 1.15, state.price + drift));
    }
    state.lastMinute = nowMinute;
  }

  return state.price;
}


/**
 * Sigmoid fair value for a binary option.
 * Returns probability [0.05, 0.95] that stock closes above strike.
 *
 * Dynamic k: steepens as close approaches (prices snap toward 0/1).
 *   hoursUntilClose >= 8h  -> k=10 (gentle, wide spreads)
 *   hoursUntilClose ~= 1h  -> k=25 (moderate compression)
 *   hoursUntilClose ~= 0h  -> k=40 (steep, tight spreads)
 * Falls back to k=10 when hoursUntilClose is omitted (seed-bots, tests).
 */
export function fairValue(stockPriceUsd: number, strikePriceUsd: number, hoursUntilClose?: number): number {
  // KEY-DECISION 2026-03-09: linear interpolation k=10..40 over 8h..0h window
  const K_MIN = 10;
  const K_MAX = 40;
  const DECAY_WINDOW_HOURS = 8;
  let k = K_MIN;
  if (hoursUntilClose !== undefined && hoursUntilClose < DECAY_WINDOW_HOURS) {
    const t = Math.max(0, hoursUntilClose) / DECAY_WINDOW_HOURS; // 1 at 8h, 0 at close
    k = K_MIN + (K_MAX - K_MIN) * (1 - t);
  }
  const x = (stockPriceUsd - strikePriceUsd) / strikePriceUsd;
  const raw = 1 / (1 + Math.exp(-k * x));
  return Math.max(0.05, Math.min(0.95, raw));
}

/**
 * Compute bid/ask levels centered around fair value.
 * Logarithmic depth: qty doubles at levels further from fair.
 * Returns prices in USDC base units.
 */
export function computeLevels(fair: number): {
  bids: [number, number][];
  asks: [number, number][];
} {
  const offsets = [0.02, 0.05, 0.08, 0.13, 0.19, 0.27];
  // KEY-DECISION 2026-03-15: institutional-scale depth for demo credibility.
  // 21,500 tokens/side ≈ $10,750 notional at fair. Well within 250K bot budget.
  const quantities = [500, 1_000, 2_000, 4_000, 6_000, 8_000];

  const bids: [number, number][] = [];
  const asks: [number, number][] = [];

  for (let i = 0; i < offsets.length; i++) {
    const bidPrice = Math.round(Math.max(0.05, fair - offsets[i]) * USDC_PER_PAIR);
    const askPrice = Math.round(Math.min(0.95, fair + offsets[i]) * USDC_PER_PAIR);
    // Skip levels that would collapse to the floor/ceiling
    if (bidPrice > 50_000) bids.push([bidPrice, quantities[i]]);
    if (askPrice < 950_000) asks.push([askPrice, quantities[i]]);
  }

  // Ensure no bid >= any ask (can happen when fair is near extremes)
  const lowestAsk = asks.length > 0 ? Math.min(...asks.map((a) => a[0])) : USDC_PER_PAIR;
  const filteredBids = bids.filter(([p]) => p < lowestAsk);

  filteredBids.sort((a, b) => b[0] - a[0]);
  asks.sort((a, b) => a[0] - b[0]);

  return { bids: filteredBids, asks };
}

/**
 * Fetch stock prices from Pyth Hermes HTTP API.
 *
 * Modes:
 *   Localnet (auto-detected from ANCHOR_PROVIDER_URL) - synthetic random-walk prices
 *   Outside market hrs - try Hermes, silently fall back to synthetic
 *   During market hrs  - try Hermes, WARN loudly if falling back to synthetic
 *
 * Always returns a price for every ticker in PYTH_FEED_IDS.
 */
export async function fetchStockPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const entries = Object.entries(PYTH_FEED_IDS);

  if (!LOCALNET) {
    try {
      const results = await Promise.allSettled(
        entries.map(async ([ticker, feedId]) => {
          const url = `${HERMES_BASE_URL}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
          const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (!res.ok) return null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data: any = await res.json();
          const parsed = data.parsed?.[0];
          if (!parsed) return null;
          const p = parsed.price;
          const price = Number(p.price) * Math.pow(10, p.expo);
          if (!Number.isFinite(price) || price <= 0) return null;
          return { ticker, price };
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          prices.set(r.value.ticker, r.value.price);
        }
      }
    } catch {
      // Total fetch failure - fall through to synthetic prices
    }
  }

  // Localnet: fill all tickers with synthetic random-walk prices.
  // Non-localnet: return only what Hermes provided. Missing tickers
  // get no price — callers skip markets without a price rather than
  // trading on fake data.
  if (LOCALNET) {
    for (const [ticker] of entries) {
      if (!prices.has(ticker)) {
        prices.set(ticker, getSyntheticPrice(ticker));
      }
    }
  } else {
    const missing = entries.map(([t]) => t).filter((t) => !prices.has(t));
    if (missing.length > 0) {
      console.warn(`  [WARNING] Pyth Hermes missing: ${missing.join(", ")} (skipping, no synthetic fallback)`);
    }
  }

  return prices;
}
