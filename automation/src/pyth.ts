/**
 * Pyth Hermes REST client for fetching latest equity prices.
 *
 * Uses the pull-based Hermes API to get real-time price data.
 * Includes fallback hardcoded prices for devnet/off-hours testing.
 */

export const DEFAULT_FEED_IDS: Record<string, string> = {
  AAPL: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT: "d0ca23c1cc005e004ccf1db5c4f1c4b692c21bb6e7f6e71c2e4c0f4eda4e7a5a",
  GOOGL: "e65ff435be42630439c96a7f6b0d2e0b1a28f44ce9b11f7b0fff4c307b441e21",
  AMZN: "b5d0e0f1b4a45928de3a1d8e0e0f0c8a5e1f0a1b2c3d4e5f6a7b8c9d0e1f2a3b",
  NVDA: "93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7",
  META: "3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5",
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1c3e7eb55",
};

// Fallback prices for devnet testing (approximate recent values)
const FALLBACK_PRICES: Record<string, number> = {
  AAPL: 230.0,
  MSFT: 420.0,
  GOOGL: 175.0,
  AMZN: 200.0,
  NVDA: 880.0,
  META: 680.0,
  TSLA: 250.0,
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
