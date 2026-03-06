import { useNavigate } from "react-router-dom";
import type { StockPrice } from "../lib/pyth";

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

  return (
    <button
      onClick={() => navigate(`/trade/${ticker}`)}
      className="bg-gray-900 border border-gray-800 rounded-lg p-5 text-left hover:border-green-500/50 transition-colors cursor-pointer"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-lg font-bold text-white">{ticker}</span>
        <span className="text-xs text-gray-500">{name}</span>
      </div>
      <div className="text-2xl font-bold text-green-400 mb-2">
        {price ? `$${price.price.toFixed(2)}` : "--"}
      </div>
      <div className="text-xs text-gray-500">
        {strikeCount > 0 ? `${strikeCount} active strikes` : "No active markets"}
      </div>
    </button>
  );
}
