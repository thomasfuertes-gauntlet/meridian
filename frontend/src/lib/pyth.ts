const HERMES_BASE = "https://hermes.pyth.network";
const debugRpc = new URLSearchParams(window.location.search).has("debug");

interface PythPrice {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

interface HermesResponse {
  parsed: Array<{
    id: string;
    price: PythPrice;
  }>;
}

export interface StockPrice {
  ticker: string;
  price: number;
  confidence: number;
  publishTime: number;
}

export async function fetchPrices(
  feedIds: string[]
): Promise<Map<string, StockPrice>> {
  // Fetch individually so one bad/offline feed doesn't 404 the entire batch
  const results = await Promise.allSettled(
    feedIds.map(async (id) => {
      const url = `${HERMES_BASE}/v2/updates/price/latest?ids[]=${id}&parsed=true`;
      if (debugRpc) console.debug(`[pyth] fetch ${id.slice(0, 8)}...`);
      const res = await fetch(url);
      if (!res.ok) return null;
      const data: HermesResponse = await res.json();
      return data.parsed[0] ?? null;
    })
  );

  const map = new Map<string, StockPrice>();
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const entry = result.value;
    const p = entry.price;
    const price = Number(p.price) * Math.pow(10, p.expo);
    const confidence = Number(p.conf) * Math.pow(10, p.expo);
    map.set(entry.id, {
      ticker: "", // caller maps feed ID -> ticker
      price,
      confidence,
      publishTime: p.publish_time,
    });
  }

  return map;
}
