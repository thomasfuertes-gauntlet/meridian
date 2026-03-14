/**
 * Fair value computation for binary outcome markets.
 * Sigmoid function: probability that stock closes above strike.
 * Also fetches live stock prices from Pyth Hermes HTTP API.
 */

import { USDC_PER_PAIR, PYTH_FEED_IDS } from "./constants";

const FETCH_TIMEOUT_MS = 5_000;
const OFFLINE = process.env.OFFLINE === "1";

/**
 * US equity market hours check (ET).
 * Returns true during weekday 9:30 AM - 4:30 PM ET (30min buffer after close).
 * Used to decide whether missing Pyth data is expected or alarming.
 */
function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false; // weekend
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 570 && minutes <= 990; // 9:30 AM - 4:30 PM
}

// Fallback prices near setup-local.ts strikes for interesting fair values.
// Used when Pyth Hermes is unavailable (weekends, off-hours, network issues).
const FALLBACK_PRICES: Record<string, number> = {
  AAPL: 237,
  MSFT: 432,
  GOOGL: 185,
  AMZN: 206,
  NVDA: 134,
  META: 700,
  TSLA: 258,
};

// Synthetic random walk state (persists across calls within a process)
const syntheticPrices = new Map<string, number>();

function getSyntheticPrice(ticker: string): number {
  let price = syntheticPrices.get(ticker);
  if (price === undefined) {
    price = FALLBACK_PRICES[ticker] ?? 100;
    syntheticPrices.set(ticker, price);
  }
  // Random walk: drift +-0.5% per call
  const drift = (Math.random() - 0.5) * 0.01 * price;
  price = Math.max(price * 0.85, Math.min(price * 1.15, price + drift));
  syntheticPrices.set(ticker, price);
  return price;
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
  const quantities = [10, 15, 25, 40, 50, 60];

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
 *   OFFLINE=1 env var  - skip Hermes entirely, use synthetic random-walk prices
 *   Outside market hrs - try Hermes, silently fall back to synthetic
 *   During market hrs  - try Hermes, WARN loudly if falling back to synthetic
 *
 * Always returns a price for every ticker in PYTH_FEED_IDS.
 */
export async function fetchStockPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const entries = Object.entries(PYTH_FEED_IDS);

  if (!OFFLINE) {
    try {
      const results = await Promise.allSettled(
        entries.map(async ([ticker, feedId]) => {
          const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
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

  // Fill missing tickers with synthetic random-walk prices
  const missingTickers: string[] = [];
  for (const [ticker] of entries) {
    if (!prices.has(ticker)) {
      prices.set(ticker, getSyntheticPrice(ticker));
      missingTickers.push(ticker);
    }
  }

  if (missingTickers.length > 0) {
    if (OFFLINE) {
      console.log("  [OFFLINE] Synthetic prices:", missingTickers.join(", "));
    } else if (isMarketHours()) {
      console.warn(`  [WARNING] Pyth Hermes failed during market hours! Synthetic fallback for: ${missingTickers.join(", ")}`);
    } else {
      console.log("  [off-hours] Synthetic prices for:", missingTickers.join(", "));
    }
  }

  return prices;
}
