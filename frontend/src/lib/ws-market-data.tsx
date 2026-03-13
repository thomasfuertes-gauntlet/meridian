import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PublicKey } from "@solana/web3.js";
import { connection, getReadOnlyProgram } from "./anchor";
import { MAG7, PROGRAM_ID, USDC_PER_PAIR, type Ticker } from "./constants";
import { parseOrderBook, type ParsedOrderBook } from "./orderbook";
import { fetchPrices } from "./pyth";
import { MarketDataContext } from "./market-data-context";
import type {
  MarketUniverse,
  MarketRecord,
  TickerSnapshot,
  MarketStatus,
  MarketOutcome,
} from "./market-data";

export type { MarketUniverse, MarketRecord, TickerSnapshot, MarketStatus, MarketOutcome };

// --- internal helpers (mirrors market-data.ts) ---

function decodeEnum(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > 0) return keys[0];
  }
  return "unknown";
}

function normalizeStatus(value: unknown): MarketStatus {
  switch (decodeEnum(value)) {
    case "created":
    case "Created":
      return "created";
    case "frozen":
    case "Frozen":
      return "frozen";
    case "settled":
    case "Settled":
      return "settled";
    default:
      return "created";
  }
}

function normalizeOutcome(value: unknown): MarketOutcome {
  switch (decodeEnum(value)) {
    case "yesWins":
    case "YesWins":
      return "yesWins";
    case "noWins":
    case "NoWins":
      return "noWins";
    default:
      return "pending";
  }
}

function computeDerived(
  base: Omit<MarketRecord, "bestBid" | "bestAsk" | "bestNoBid" | "bestNoAsk" | "yesMid" | "totalDepth" | "orderBook">,
  orderBook: ParsedOrderBook | null
): MarketRecord {
  const bestBid = orderBook?.bids[0]?.price ?? null;
  const bestAsk = orderBook?.asks[0]?.price ?? null;
  const yesMid =
    bestBid != null && bestAsk != null ? Math.round((bestBid + bestAsk) / 2) : null;
  const bestNoBid = bestAsk != null ? USDC_PER_PAIR - bestAsk : null;
  const bestNoAsk = bestBid != null ? USDC_PER_PAIR - bestBid : null;
  const totalDepth = orderBook
    ? orderBook.bids.reduce((s, o) => s + o.quantity, 0) +
      orderBook.asks.reduce((s, o) => s + o.quantity, 0)
    : 0;
  return { ...base, bestBid, bestAsk, bestNoBid, bestNoAsk, yesMid, totalDepth, orderBook };
}

type PriceMap = Map<string, { price: number; confidence: number; publishTime: number }>;

function buildUniverse(markets: Map<string, MarketRecord>, prices: PriceMap): MarketUniverse {
  const marketsByTicker = Object.fromEntries(
    MAG7.map((e) => [e.ticker, [] as MarketRecord[]])
  ) as Record<Ticker, MarketRecord[]>;

  for (const record of markets.values()) {
    marketsByTicker[record.ticker]?.push(record);
  }
  for (const ticker of MAG7.map((e) => e.ticker)) {
    marketsByTicker[ticker].sort((a, b) => a.strikePrice - b.strikePrice);
  }

  const tickerSnapshots: TickerSnapshot[] = MAG7.map((entry) => {
    const feedId = entry.pythFeedId.replace("0x", "");
    const price = prices.get(feedId);
    const mkt = marketsByTicker[entry.ticker];
    const activeMarketCount = mkt.filter((m) => m.status !== "settled").length;
    const created = mkt.find((m) => m.status === "created");
    const frozen = mkt.find((m) => m.status === "frozen");
    const settled = mkt.find((m) => m.status === "settled");
    const representativeStatus =
      created?.status ?? frozen?.status ?? settled?.status ?? "idle";
    const rankedByDistance = [...mkt].sort((a, b) => {
      const aMid = a.yesMid ?? 500_000;
      const bMid = b.yesMid ?? 500_000;
      return Math.abs(aMid - 500_000) - Math.abs(bMid - 500_000);
    });
    const referencePrice = price?.price ?? null;
    return {
      ticker: entry.ticker,
      company: entry.name,
      latestPrice: price?.price ?? null,
      confidence: price?.confidence ?? null,
      publishTime: price?.publishTime ?? null,
      marketCount: mkt.length,
      activeMarketCount,
      topYesMid: rankedByDistance[0]?.yesMid ?? null,
      totalOpenInterest: mkt.reduce((s, m) => s + m.totalPairsMinted, 0),
      nearestStrike: mkt.length
        ? [...mkt].sort((a, b) => {
            const fallback = mkt[0].strikePrice / USDC_PER_PAIR;
            const ref = referencePrice ?? fallback;
            return (
              Math.abs(a.strikePrice / USDC_PER_PAIR - ref) -
              Math.abs(b.strikePrice / USDC_PER_PAIR - ref)
            );
          })[0].strikePrice
        : null,
      status: representativeStatus,
    } satisfies TickerSnapshot;
  });

  return { asOf: Date.now(), tickerSnapshots, marketsByTicker };
}

// --- Context ---

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<MarketUniverse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const marketsRef = useRef<Map<string, MarketRecord>>(new Map());
  const pricesRef = useRef<PriceMap>(new Map());

  useEffect(() => {
    let alive = true;

    function rebuild() {
      if (!alive) return;
      setData(buildUniverse(marketsRef.current, pricesRef.current));
    }

    // Poll orderbooks + market status instead of per-account WS subs.
    // Helius free tier caps at 5 WS subs; per-market subs would need ~84.
    async function pollMarkets() {
      if (!alive || marketsRef.current.size === 0) return;
      try {
        const entries = [...marketsRef.current.entries()];
        const obAddresses = entries.map(([, m]) =>
          PublicKey.findProgramAddressSync(
            [Buffer.from("orderbook"), m.publicKey.toBuffer()],
            PROGRAM_ID
          )[0]
        );
        const marketAddresses = entries.map(([, m]) => m.publicKey);

        const [obAccounts, marketAccounts] = await Promise.all([
          connection.getMultipleAccountsInfo(obAddresses),
          connection.getMultipleAccountsInfo(marketAddresses),
        ]);

        const program = getReadOnlyProgram();
        let changed = false;
        entries.forEach(([address, existing], idx) => {
          // Update market status
          const marketAccount = marketAccounts[idx];
          if (marketAccount) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const decoded = (program.coder.accounts as any).decode(
                "StrikeMarket",
                marketAccount.data
              ) as {
                status: unknown;
                outcome: unknown;
                totalPairsMinted: { toNumber(): number };
                settlementPrice?: { toNumber?(): number } | null;
                settlementSource: unknown;
              };
              existing = {
                ...existing,
                status: normalizeStatus(decoded.status),
                outcome: normalizeOutcome(decoded.outcome),
                totalPairsMinted: decoded.totalPairsMinted.toNumber(),
                settlementPrice: decoded.settlementPrice?.toNumber?.() ?? null,
                settlementSource: decoded.settlementSource
                  ? decodeEnum(decoded.settlementSource)
                  : null,
              };
            } catch {
              // ignore decode errors
            }
          }
          // Update orderbook
          const obAccount = obAccounts[idx];
          const orderBook = obAccount ? parseOrderBook(obAccount) : null;
          marketsRef.current.set(address, computeDerived(existing, orderBook));
          changed = true;
        });
        if (changed) rebuild();
      } catch {
        // ignore poll errors
      }
    }

    async function coldLoad() {
      const program = getReadOnlyProgram();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawMarkets = await (program.account as any).strikeMarket.all();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const normalized = (rawMarkets as any[]).map((item) => ({
        address: (item.publicKey as PublicKey).toBase58(),
        publicKey: item.publicKey as PublicKey,
        ticker: item.account.ticker as Ticker,
        company:
          MAG7.find((e) => e.ticker === item.account.ticker)?.name ?? item.account.ticker,
        yesMint: item.account.yesMint as PublicKey,
        noMint: item.account.noMint as PublicKey,
        vault: item.account.vault as PublicKey,
        strikePrice: item.account.strikePrice.toNumber() as number,
        date: item.account.date.toNumber() as number,
        closeTime: item.account.closeTime.toNumber() as number,
        status: normalizeStatus(item.account.status),
        outcome: normalizeOutcome(item.account.outcome),
        totalPairsMinted: item.account.totalPairsMinted.toNumber() as number,
        settlementPrice: item.account.settlementPrice?.toNumber?.() ?? null,
        settlementSource: item.account.settlementSource
          ? decodeEnum(item.account.settlementSource)
          : null,
      }));

      // Only latest date per ticker
      const latestDates = new Map<Ticker, number>();
      for (const m of normalized) {
        const cur = latestDates.get(m.ticker);
        if (cur == null || m.date > cur) latestDates.set(m.ticker, m.date);
      }
      const activeSet = normalized.filter(
        (m: { ticker: Ticker; date: number }) => latestDates.get(m.ticker) === m.date
      );

      const obAddresses = activeSet.map(
        (m: { publicKey: PublicKey }) =>
          PublicKey.findProgramAddressSync(
            [Buffer.from("orderbook"), m.publicKey.toBuffer()],
            PROGRAM_ID
          )[0]
      );
      const obAccounts = obAddresses.length
        ? await connection.getMultipleAccountsInfo(obAddresses)
        : [];

      const newPrices = await fetchPrices(MAG7.map((e) => e.pythFeedId));
      const priceMap: PriceMap = new Map();
      for (const [feedId, stock] of newPrices.entries()) {
        priceMap.set(feedId, {
          price: stock.price,
          confidence: stock.confidence,
          publishTime: stock.publishTime,
        });
      }
      pricesRef.current = priceMap;

      const newMarkets = new Map<string, MarketRecord>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      activeSet.forEach((m: any, idx: number) => {
        const bookAccount = obAccounts[idx];
        const orderBook = bookAccount ? parseOrderBook(bookAccount) : null;
        newMarkets.set(m.address, computeDerived(m, orderBook));
      });
      marketsRef.current = newMarkets;
    }

    async function init() {
      await coldLoad();
      if (!alive) return;
      rebuild();
      setError(null);
    }

    init()
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Failed to load markets");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    // Poll orderbooks + market status every 10s (replaces per-market WS subs)
    const pollInterval = window.setInterval(() => {
      if (alive) void pollMarkets();
    }, 10_000);

    // Refresh Pyth prices every 30s
    const pythInterval = window.setInterval(async () => {
      if (!alive) return;
      try {
        const newPrices = await fetchPrices(MAG7.map((e) => e.pythFeedId));
        const priceMap: PriceMap = new Map();
        for (const [feedId, stock] of newPrices.entries()) {
          priceMap.set(feedId, {
            price: stock.price,
            confidence: stock.confidence,
            publishTime: stock.publishTime,
          });
        }
        pricesRef.current = priceMap;
        if (alive) rebuild();
      } catch {
        // ignore Pyth errors
      }
    }, 30_000);

    // Re-discover new markets every 5 minutes
    const discoveryInterval = window.setInterval(async () => {
      if (!alive) return;
      try {
        await coldLoad();
        if (alive) rebuild();
      } catch {
        // ignore
      }
    }, 5 * 60_000);

    return () => {
      alive = false;
      window.clearInterval(pollInterval);
      window.clearInterval(pythInterval);
      window.clearInterval(discoveryInterval);
    };
  }, []);

  return (
    <MarketDataContext.Provider value={{ data, error, loading }}>
      {children}
    </MarketDataContext.Provider>
  );
}

