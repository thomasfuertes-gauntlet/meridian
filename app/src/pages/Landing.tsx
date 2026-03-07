import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { MAG7 } from "../lib/constants";
import { fetchPrices, type StockPrice } from "../lib/pyth";

export function Landing() {
  const navigate = useNavigate();
  const { connected } = useWallet();
  const [prices, setPrices] = useState<Map<string, StockPrice>>(new Map());

  useEffect(() => {
    async function load() {
      try {
        const feedIds = MAG7.map((s) => s.pythFeedId);
        const priceMap = await fetchPrices(feedIds);
        const tickerMap = new Map<string, StockPrice>();
        for (const stock of MAG7) {
          const id = stock.pythFeedId.replace("0x", "");
          const p = priceMap.get(id);
          if (p) tickerMap.set(stock.ticker, { ...p, ticker: stock.ticker });
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
    <div className="max-w-3xl mx-auto py-16">
      <h1 className="text-4xl font-bold text-white mb-4">Meridian</h1>
      <p className="text-lg text-gray-400 mb-2">
        Binary outcome markets for MAG7 stocks on Solana.
      </p>
      <p className="text-gray-500 mb-10">
        Trade Yes/No tokens on whether a stock closes above a strike price
        today. $1.00 payout if you're right. $0.00 if you're wrong.
        Non-custodial. Settles daily at 4:00 PM ET.
      </p>

      {/* Live price ticker strip */}
      <div className="flex flex-wrap gap-3 mb-10">
        {MAG7.map((stock) => {
          const p = prices.get(stock.ticker);
          return (
            <Link
              key={stock.ticker}
              to={`/trade/${stock.ticker}`}
              className="bg-gray-900 border border-gray-800 rounded px-4 py-2 text-sm hover:border-green-800 transition-colors"
            >
              <span className="font-bold text-white mr-2">
                {stock.ticker}
              </span>
              <span className="text-green-400 font-mono">
                {p ? `$${p.price.toFixed(2)}` : "--"}
              </span>
            </Link>
          );
        })}
      </div>

      {/* CTA */}
      <div className="flex gap-4">
        {connected ? (
          <button
            onClick={() => navigate("/markets")}
            className="bg-green-600 hover:bg-green-500 text-white font-medium px-6 py-3 rounded-lg transition-colors"
          >
            View Markets
          </button>
        ) : (
          <WalletMultiButton />
        )}
      </div>

      {/* How it works */}
      <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-6">
        <div>
          <h3 className="text-white font-bold mb-2">1. Pick a side</h3>
          <p className="text-gray-500 text-sm">
            Will META close above $680 today? Buy Yes or No tokens at
            market-implied odds.
          </p>
        </div>
        <div>
          <h3 className="text-white font-bold mb-2">2. Trade on the book</h3>
          <p className="text-gray-500 text-sm">
            One order book per strike. Place limit or market orders. All
            four trade paths - Buy/Sell Yes/No - on a single CLOB.
          </p>
        </div>
        <div>
          <h3 className="text-white font-bold mb-2">3. Settle at close</h3>
          <p className="text-gray-500 text-sm">
            At 4:00 PM ET, Pyth oracle settles every contract. Winners
            redeem $1.00 USDC per token. Losers get $0.00.
          </p>
        </div>
      </div>
    </div>
  );
}
