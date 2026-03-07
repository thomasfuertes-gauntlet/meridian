import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { StockPrice } from "../lib/pyth";
import { usePriceHistory } from "../lib/usePriceHistory";
import { PriceSparkline } from "./PriceSparkline";
import { USDC_PER_PAIR } from "../lib/constants";

interface MarketCardProps {
  ticker: string;
  name: string;
  price: StockPrice | null;
  strikeCount: number;
  yesMid: number | null; // CLOB mid-price in USDC base units
}

export function MarketCard({
  ticker,
  name,
  price,
  strikeCount,
  yesMid,
}: MarketCardProps) {
  const navigate = useNavigate();
  // Separate history for CLOB mid-price (moves with bot activity, even outside market hours)
  const { history: clobHistory, push: pushClob } = usePriceHistory(`${ticker}-clob`);

  // Feed CLOB mid-price into sparkline history
  useEffect(() => {
    if (yesMid != null) pushClob(yesMid / USDC_PER_PAIR);
  }, [yesMid, pushClob]);

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
        <div>
          <div className="text-2xl font-bold text-green-400">
            {price ? `$${price.price.toFixed(2)}` : "--"}
          </div>
          {yesMid != null && (
            <div className="text-sm text-gray-400 mt-0.5">
              Yes{" "}
              <span className="text-white font-mono">
                ${(yesMid / USDC_PER_PAIR).toFixed(2)}
              </span>
            </div>
          )}
        </div>
        {clobHistory.length >= 2 && (
          <PriceSparkline prices={[...clobHistory]} width={80} height={32} />
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
