import { useState, useEffect } from "react";
import { MarketCard } from "../components/MarketCard";
import { SettlementCountdown } from "../components/SettlementCountdown";
import { MAG7 } from "../lib/constants";
import { fetchPrices, type StockPrice } from "../lib/pyth";

export function Markets() {
  const [prices, setPrices] = useState<Map<string, StockPrice>>(new Map());

  useEffect(() => {
    async function load() {
      try {
        const feedIds = MAG7.map((s) => s.pythFeedId);
        const priceMap = await fetchPrices(feedIds);
        // Map feed IDs to tickers
        const tickerMap = new Map<string, StockPrice>();
        for (const stock of MAG7) {
          const id = stock.pythFeedId.replace("0x", "");
          const p = priceMap.get(id);
          if (p) {
            tickerMap.set(stock.ticker, { ...p, ticker: stock.ticker });
          }
        }
        setPrices(tickerMap);
      } catch (err) {
        console.error("Failed to fetch prices:", err);
      }
    }
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Markets</h1>
        <SettlementCountdown />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {MAG7.map((stock) => (
          <MarketCard
            key={stock.ticker}
            ticker={stock.ticker}
            name={stock.name}
            price={prices.get(stock.ticker) ?? null}
            strikeCount={0}
          />
        ))}
      </div>
    </div>
  );
}
