import { useContext, useMemo } from "react";
import { MarketDataContext } from "./market-data-context";

export function useMarketData() {
  const ctx = useContext(MarketDataContext);
  const stats = useMemo(() => {
    const snapshots = ctx.data?.tickerSnapshots ?? [];
    return {
      activeTickers: snapshots.filter((item) => item.marketCount > 0).length,
      totalMarkets: snapshots.reduce((sum, item) => sum + item.marketCount, 0),
      totalOpenInterest: snapshots.reduce((sum, item) => sum + item.totalOpenInterest, 0),
    };
  }, [ctx.data]);

  return { ...ctx, stats };
}
