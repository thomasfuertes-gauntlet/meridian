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

export function createPriceStream(
  feedIds: string[],
  onUpdate: (prices: Map<string, StockPrice>) => void
): { close(): void } {
  let backoff = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let es: EventSource | null = null;
  let closed = false;

  function connect() {
    if (closed) return;
    const params = feedIds.map((id) => `ids[]=${id}`).join("&");
    const url = `${HERMES_BASE}/v2/updates/price/stream?${params}&parsed=true&ignore_invalid_price_ids=true`;
    if (debugRpc) console.debug("[pyth-sse] connecting...");

    es = new EventSource(url);

    es.onmessage = (event) => {
      backoff = 1000; // reset on success
      try {
        const data = JSON.parse(event.data) as HermesResponse;
        const map = new Map<string, StockPrice>();
        for (const entry of data.parsed) {
          const p = entry.price;
          const price = Number(p.price) * Math.pow(10, p.expo);
          const confidence = Number(p.conf) * Math.pow(10, p.expo);
          map.set(entry.id, { ticker: "", price, confidence, publishTime: p.publish_time });
        }
        if (map.size > 0) onUpdate(map);
      } catch {
        if (debugRpc) console.warn("[pyth-sse] parse error");
      }
    };

    es.onerror = () => {
      if (closed) return;
      es?.close();
      if (debugRpc) console.debug(`[pyth-sse] reconnecting in ${backoff}ms`);
      reconnectTimer = setTimeout(() => {
        backoff = Math.min(backoff * 2, 30_000);
        connect();
      }, backoff);
    };
  }

  connect();

  return {
    close() {
      closed = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    },
  };
}
