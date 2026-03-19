/**
 * Pyth Hermes REST client for fetching latest equity prices.
 *
 * Uses the pull-based Hermes API to get real-time price data.
 * Includes fallback hardcoded prices for devnet/off-hours testing.
 */

// KEY-DECISION 2026-03-17: mainnet and devnet Pyth use different feed IDs.
// Verified via hermes[-beta].pyth.network/v2/price_feeds?query=<TICKER>&asset_type=equity
// Selected at runtime from ANCHOR_PROVIDER_URL (mainnet = no "devnet"/localhost in URL).
const PYTH_FEED_IDS_DEVNET: Record<string, string> = {
  AAPL: "afcc9a5bb5eefd55e12b6f0b4c8e6bccf72b785134ee232a5d175afd082e8832",
  MSFT: "4e10201a9ad79892f1b4e9a468908f061f330272c7987ddc6506a254f77becd7",
  GOOGL: "545b468a0fc88307cf64f7cda62b190363089527f4b597887be5611b6cefe4f1",
  AMZN: "095e126b86f4f416a21da0c44b997a379e8647514a1b78204ca0a6267801d00f",
  NVDA: "16e38262485de554be6a09b0c1d4d86eb2151a7af265f867d769dee359cec32e",
  META: "057aef33dd5ca9b91bef92c6aee08bca76565934008ed3c8d55e382ed17fb883",
  TSLA: "7dac7cafc583cc4e1ce5c6772c444b8cd7addeecd5bedb341dfa037c770ae71e",
};

const PYTH_FEED_IDS_MAINNET: Record<string, string> = {
  AAPL: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  GOOGL: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
  AMZN: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  NVDA: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  META: "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
};

function isMainnet(): boolean {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "";
  return !url.includes("devnet") && !url.includes("127.0.0.1") && !url.includes("localhost");
}

export const PYTH_FEED_IDS: Record<string, string> = isMainnet()
  ? PYTH_FEED_IDS_MAINNET
  : PYTH_FEED_IDS_DEVNET;

// KEY-DECISION 2026-03-19: Hermes endpoint must match feed ID set.
// Mainnet Hermes 404s on devnet feed IDs and vice versa.
export const HERMES_BASE_URL = isMainnet()
  ? "https://hermes.pyth.network"
  : "https://hermes-beta.pyth.network";

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
  feedIds: Record<string, string> = PYTH_FEED_IDS,
  hermesUrl: string = HERMES_BASE_URL
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
