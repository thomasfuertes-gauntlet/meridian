import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { StockPrice } from "../lib/pyth";
import { usePriceHistory } from "../lib/usePriceHistory";
import { PriceSparkline } from "./PriceSparkline";

interface MarketCardProps {
  ticker: string;
  name: string;
  price: StockPrice | null;
  strikeCount: number;
}

export function MarketCard({
  ticker,
  name,
  price,
  strikeCount,
}: MarketCardProps) {
  const navigate = useNavigate();
  const { history, push } = usePriceHistory(ticker);

  useEffect(() => {
    if (price) push(price.price);
  }, [price, push]);

  return (
    <button
      onClick={() => navigate(`/trade/${ticker}`)}
      className="bg-gray-900 border border-gray-800 rounded-lg p-5 text-left hover:border-green-500/50 transition-colors cursor-pointer relative overflow-hidden"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-lg font-bold text-white">{ticker}</span>
        <span className="text-xs text-gray-500">{name}</span>
      </div>
      <div className="flex items-end justify-between gap-2 mb-2">
        <div className="text-2xl font-bold text-green-400">
          {price ? `$${price.price.toFixed(2)}` : "--"}
        </div>
        {history.length >= 2 && (
          <PriceSparkline prices={[...history]} width={80} height={32} />
        )}
      </div>
      <div className="text-xs text-gray-500">
        {strikeCount > 0
          ? `${strikeCount} active strikes`
          : "No active markets"}
      </div>
    </button>
  );
}
