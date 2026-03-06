import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { OrderBook } from "../components/OrderBook";
import { TradePanel } from "../components/TradePanel";
import { SettlementCountdown } from "../components/SettlementCountdown";
import { MAG7, PROGRAM_ID, USDC_PER_PAIR } from "../lib/constants";
import { getProgram } from "../lib/anchor";
import {
  parseOrderBook,
  flipToNoPerspective,
  type ParsedOrderBook,
} from "../lib/orderbook";
import { fetchPrices, type StockPrice } from "../lib/pyth";

interface MarketInfo {
  pubkey: PublicKey;
  ticker: string;
  strikePrice: number;
  date: number;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  settled: boolean;
  outcome: string;
}

export function Trade() {
  const { ticker } = useParams<{ ticker: string }>();
  const navigate = useNavigate();
  const wallet = useAnchorWallet();
  const { connection } = useConnection();

  const stock = MAG7.find((s) => s.ticker === ticker);
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<MarketInfo | null>(
    null
  );
  const [orderBook, setOrderBook] = useState<ParsedOrderBook | null>(null);
  const [price, setPrice] = useState<StockPrice | null>(null);

  // Fetch markets for this ticker
  const loadMarkets = useCallback(async () => {
    if (!wallet || !ticker) return;
    try {
      const program = getProgram(wallet);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allMarkets = await (program.account as any).strikeMarket.all();
      const tickerMarkets = allMarkets
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((m: any) => m.account.ticker === ticker)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((m: any) => ({
          pubkey: m.publicKey,
          ticker: m.account.ticker as string,
          strikePrice: m.account.strikePrice.toNumber(),
          date: m.account.date.toNumber(),
          yesMint: m.account.yesMint as PublicKey,
          noMint: m.account.noMint as PublicKey,
          vault: m.account.vault as PublicKey,
          settled: m.account.outcome?.pending === undefined,
          outcome: JSON.stringify(m.account.outcome),
        }))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sort((a: any, b: any) => a.strikePrice - b.strikePrice);

      setMarkets(tickerMarkets);
      if (tickerMarkets.length > 0 && !selectedMarket) {
        setSelectedMarket(tickerMarkets[0]);
      }
    } catch (err) {
      console.error("Failed to load markets:", err);
    }
  }, [wallet, ticker, selectedMarket]);

  // Fetch order book for selected market
  const loadOrderBook = useCallback(async () => {
    if (!selectedMarket) return;
    try {
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), selectedMarket.pubkey.toBuffer()],
        PROGRAM_ID
      );
      const info = await connection.getAccountInfo(obPda);
      if (info) {
        setOrderBook(parseOrderBook(info));
      }
    } catch (err) {
      console.error("Failed to load order book:", err);
    }
  }, [selectedMarket, connection]);

  // Fetch live price
  useEffect(() => {
    if (!stock) return;
    async function load() {
      try {
        const priceMap = await fetchPrices([stock!.pythFeedId]);
        const id = stock!.pythFeedId.replace("0x", "");
        const p = priceMap.get(id);
        if (p) setPrice({ ...p, ticker: stock!.ticker });
      } catch (err) {
        console.error("Failed to fetch price:", err);
      }
    }
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [stock]);

  useEffect(() => {
    loadMarkets();
  }, [loadMarkets]);

  useEffect(() => {
    loadOrderBook();
    if (!selectedMarket) return;
    // Subscribe to order book account changes
    const [obPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), selectedMarket.pubkey.toBuffer()],
      PROGRAM_ID
    );
    const subId = connection.onAccountChange(obPda, (info) => {
      setOrderBook(parseOrderBook(info));
    });
    return () => {
      connection.removeAccountChangeListener(subId);
    };
  }, [selectedMarket, connection, loadOrderBook]);

  if (!stock) {
    return (
      <div className="text-gray-500">
        Unknown ticker.{" "}
        <button onClick={() => navigate("/")} className="text-green-400 underline">
          Back to markets
        </button>
      </div>
    );
  }

  const noBook = orderBook ? flipToNoPerspective(orderBook) : null;
  const bestBid =
    orderBook && orderBook.bids.length > 0 ? orderBook.bids[0].price : null;
  const bestAsk =
    orderBook && orderBook.asks.length > 0 ? orderBook.asks[0].price : null;

  // We need a USDC mint address - derive from config or use a known devnet mint
  // For now, use the vault's token type. The actual USDC mint should come from config.
  const DEVNET_USDC_MINT = new PublicKey(
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" // placeholder - update with actual devnet USDC mint
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/")}
            className="text-gray-500 hover:text-gray-300"
          >
            &larr;
          </button>
          <h1 className="text-2xl font-bold text-white">{stock.ticker}</h1>
          <span className="text-gray-500">{stock.name}</span>
          {price && (
            <span className="text-green-400 font-mono text-lg">
              ${price.price.toFixed(2)}
            </span>
          )}
        </div>
        <SettlementCountdown />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Strike list */}
        <div className="lg:col-span-3">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-bold text-gray-300 mb-3">Strikes</h3>
            {markets.length === 0 ? (
              <p className="text-xs text-gray-600">
                {wallet
                  ? "No active markets for this ticker"
                  : "Connect wallet to view markets"}
              </p>
            ) : (
              <div className="space-y-1">
                {markets.map((m) => (
                  <button
                    key={m.pubkey.toString()}
                    onClick={() => setSelectedMarket(m)}
                    className={`w-full text-left text-sm px-3 py-2 rounded transition-colors ${
                      selectedMarket?.pubkey.equals(m.pubkey)
                        ? "bg-gray-800 text-white"
                        : "text-gray-400 hover:bg-gray-800/50"
                    }`}
                  >
                    <span className="font-mono">
                      ${(m.strikePrice / USDC_PER_PAIR).toFixed(2)}
                    </span>
                    {m.settled && (
                      <span className="ml-2 text-xs text-yellow-400">
                        Settled
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Order book */}
        <div className="lg:col-span-5">
          <OrderBook
            bids={orderBook?.bids ?? []}
            asks={orderBook?.asks ?? []}
            noBids={noBook?.bids ?? []}
            noAsks={noBook?.asks ?? []}
          />
        </div>

        {/* Trade panel */}
        <div className="lg:col-span-4">
          {selectedMarket ? (
            <TradePanel
              market={selectedMarket.pubkey}
              yesMint={selectedMarket.yesMint}
              noMint={selectedMarket.noMint}
              usdcMint={DEVNET_USDC_MINT}
              strikePrice={selectedMarket.strikePrice}
              ticker={stock.ticker}
              bestBid={bestBid}
              bestAsk={bestAsk}
            />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-500">
              Select a strike to trade
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
