/**
 * Fair value computation for binary outcome markets.
 * Sigmoid function: probability that stock closes above strike.
 * Also fetches live stock prices from Pyth Hermes HTTP API.
 */

const USDC_PER_PAIR = 1_000_000;

// Pyth Hermes feed IDs (no 0x prefix for API calls)
const PYTH_FEED_IDS: Record<string, string> = {
  AAPL: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  GOOGL: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
  AMZN: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  NVDA: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  META: "2b9ab1e972a281585084148ba1389800799bd4be63b957507db1349314e47445",
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
};

/**
 * Sigmoid fair value for a binary option.
 * Returns probability [0.05, 0.95] that stock closes above strike.
 * k=10 gives: at strike -> 0.50, 5% above -> ~0.62, 10% above -> ~0.73
 */
export function fairValue(stockPriceUsd: number, strikePriceUsd: number): number {
  const k = 10;
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
 * Returns Map<ticker, priceUsd>. Missing/failed tickers are omitted.
 */
export async function fetchStockPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const entries = Object.entries(PYTH_FEED_IDS);

  const results = await Promise.allSettled(
    entries.map(async ([ticker, feedId]) => {
      const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const parsed = data.parsed?.[0];
      if (!parsed) return null;
      const p = parsed.price;
      const price = Number(p.price) * Math.pow(10, p.expo);
      return { ticker, price };
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      prices.set(r.value.ticker, r.value.price);
    }
  }
  return prices;
}
