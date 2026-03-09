/**
 * Pyth Hermes REST client for fetching latest equity prices.
 *
 * Uses the pull-based Hermes API to get real-time price data.
 * Includes fallback hardcoded prices for devnet/off-hours testing.
 */

export const DEFAULT_FEED_IDS: Record<string, string> = {
  AAPL: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  GOOGL: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
  AMZN: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  NVDA: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  META: "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
};

// Fallback prices for devnet testing (approximate recent values)
const FALLBACK_PRICES: Record<string, number> = {
  AAPL: 256.0,
  MSFT: 405.0,
  GOOGL: 300.0,
  AMZN: 210.0,
  NVDA: 179.0,
  META: 634.0,
  TSLA: 389.0,
};

export interface PythPrice {
  price: number; // price in dollars
  confidence: number; // confidence band in dollars
  publishTime: number; // unix timestamp
}

interface HermesParsedEntry {
  id: string;
  price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
}

interface HermesResponse {
  parsed: HermesParsedEntry[];
}

/**
 * Convert a hex feed ID string to a 32-byte Uint8Array for on-chain use.
 */
export function feedIdToBytes(hexId: string): number[] {
  const clean = hexId.startsWith("0x") ? hexId.slice(2) : hexId;
  if (clean.length !== 64) {
    throw new Error(`Invalid feed ID length: expected 64 hex chars, got ${clean.length}`);
  }
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

/**
 * Fetch the latest price for a ticker from Pyth Hermes.
 * Falls back to hardcoded prices if Hermes is unavailable.
 */
export async function fetchPrice(
  ticker: string,
  feedIds: Record<string, string> = DEFAULT_FEED_IDS,
  hermesUrl: string = "https://hermes.pyth.network"
): Promise<PythPrice> {
  const feedId = feedIds[ticker];
  if (!feedId) {
    throw new Error(`No Pyth feed ID configured for ticker: ${ticker}`);
  }

  try {
    const url = `${hermesUrl}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Hermes returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as HermesResponse;

    if (!data.parsed || data.parsed.length === 0) {
      throw new Error(`No parsed price data returned for ${ticker}`);
    }

    const entry = data.parsed[0];
    const rawPrice = parseInt(entry.price.price, 10);
    const rawConf = parseInt(entry.price.conf, 10);
    const exponent = entry.price.expo;

    // Convert to dollars: price * 10^exponent
    const multiplier = Math.pow(10, exponent);
    const price = rawPrice * multiplier;
    const confidence = rawConf * multiplier;

    console.log(
      `[pyth] ${ticker}: $${price.toFixed(2)} +/- $${confidence.toFixed(2)} (expo=${exponent})`
    );

    return {
      price,
      confidence,
      publishTime: entry.price.publish_time,
    };
  } catch (err) {
    const fallback = FALLBACK_PRICES[ticker];
    if (fallback !== undefined) {
      console.warn(
        `[pyth] Failed to fetch ${ticker} from Hermes, using fallback $${fallback}: ${err}`
      );
      return {
        price: fallback,
        confidence: 0,
        publishTime: Math.floor(Date.now() / 1000),
      };
    }
    throw err;
  }
}
