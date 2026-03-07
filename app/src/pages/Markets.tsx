import { useState, useEffect } from "react";
import { MarketCard } from "../components/MarketCard";
import { SettlementCountdown } from "../components/SettlementCountdown";
import { MAG7 } from "../lib/constants";
import { getReadOnlyProgram } from "../lib/anchor";
import { fetchPrices, type StockPrice } from "../lib/pyth";

export function Markets() {
  const [prices, setPrices] = useState<Map<string, StockPrice>>(new Map());
  const [strikeCounts, setStrikeCounts] = useState<Map<string, number>>(
    new Map()
  );

  // Fetch on-chain strike counts (no wallet needed)
  useEffect(() => {
    async function loadMarkets() {
      try {
        const program = getReadOnlyProgram();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allMarkets = await (program.account as any).strikeMarket.all();
        const counts = new Map<string, number>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const m of allMarkets) {
          const ticker = m.account.ticker as string;
          counts.set(ticker, (counts.get(ticker) ?? 0) + 1);
        }
        setStrikeCounts(counts);
      } catch (err) {
        console.error("Failed to load markets:", err);
      }
    }
    loadMarkets();
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const feedIds = MAG7.map((s) => s.pythFeedId);
        const priceMap = await fetchPrices(feedIds);
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
            strikeCount={strikeCounts.get(stock.ticker) ?? 0}
          />
        ))}
      </div>
    </div>
  );
}
