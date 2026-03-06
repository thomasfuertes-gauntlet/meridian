const HERMES_BASE = "https://hermes.pyth.network";

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
  const params = feedIds.map((id) => `ids[]=${id}`).join("&");
  const url = `${HERMES_BASE}/v2/updates/price/latest?${params}&parsed=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hermes fetch failed: ${res.status}`);

  const data: HermesResponse = await res.json();
  const map = new Map<string, StockPrice>();

  for (const entry of data.parsed) {
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
