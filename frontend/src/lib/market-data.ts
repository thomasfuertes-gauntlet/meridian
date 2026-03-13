import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { connection, getReadOnlyProgram } from "./anchor";
import { MAG7, MARKET_POLL_MS, PROGRAM_ID, USDC_PER_PAIR, type Ticker } from "./constants";
import { parseOrderBook, type ParsedOrderBook } from "./orderbook";
import { fetchPrices } from "./pyth";

export type MarketStatus = "created" | "frozen" | "settled";
export type MarketOutcome = "pending" | "yesWins" | "noWins";

export interface MarketRecord {
  address: string;
  publicKey: PublicKey;
  ticker: Ticker;
  company: string;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  strikePrice: number;
  date: number;
  closeTime: number;
  status: MarketStatus;
  outcome: MarketOutcome;
  totalPairsMinted: number;
  settlementPrice: number | null;
  settlementSource: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  bestNoBid: number | null;
  bestNoAsk: number | null;
  yesMid: number | null;
  totalDepth: number;
  orderBook: ParsedOrderBook | null;
}

export interface TickerSnapshot {
  ticker: Ticker;
  company: string;
  latestPrice: number | null;
  confidence: number | null;
  publishTime: number | null;
  marketCount: number;
  activeMarketCount: number;
  topYesMid: number | null;
  totalOpenInterest: number;
  nearestStrike: number | null;
  status: MarketStatus | "idle";
}

export interface MarketUniverse {
  asOf: number;
  tickerSnapshots: TickerSnapshot[];
  marketsByTicker: Record<Ticker, MarketRecord[]>;
}

let marketUniverseCache: MarketUniverse | null = null;
let marketUniverseCacheAt = 0;
let marketUniverseInflight: Promise<MarketUniverse> | null = null;

interface NormalizedMarketBase {
  address: string;
  publicKey: PublicKey;
  ticker: Ticker;
  company: string;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  strikePrice: number;
  date: number;
  closeTime: number;
  status: MarketStatus;
  outcome: MarketOutcome;
  totalPairsMinted: number;
  settlementPrice: number | null;
  settlementSource: string | null;
}

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

function latestDateByTicker(records: Array<{ ticker: Ticker; date: number }>): Map<Ticker, number> {
  const dates = new Map<Ticker, number>();
  for (const record of records) {
    const current = dates.get(record.ticker);
    if (current == null || record.date > current) {
      dates.set(record.ticker, record.date);
    }
  }
  return dates;
}

function deserializeOrderBook(book: {
  market: string;
  obUsdcVault: string;
  obYesVault: string;
  nextOrderId: number;
  bidCount: number;
  askCount: number;
  bump: number;
  bids: Array<{ owner: string; price: number; quantity: number; timestamp: number; orderId: number; isActive: boolean }>;
  asks: Array<{ owner: string; price: number; quantity: number; timestamp: number; orderId: number; isActive: boolean }>;
} | null): ParsedOrderBook | null {
  if (!book) return null;
  return {
    market: new PublicKey(book.market),
    obUsdcVault: new PublicKey(book.obUsdcVault),
    obYesVault: new PublicKey(book.obYesVault),
    nextOrderId: book.nextOrderId,
    bidCount: book.bidCount,
    askCount: book.askCount,
    bump: book.bump,
    bids: book.bids.map((order) => ({
      owner: new PublicKey(order.owner),
      price: order.price,
      quantity: order.quantity,
      timestamp: order.timestamp,
      orderId: order.orderId,
      isActive: order.isActive,
    })),
    asks: book.asks.map((order) => ({
      owner: new PublicKey(order.owner),
      price: order.price,
      quantity: order.quantity,
      timestamp: order.timestamp,
      orderId: order.orderId,
      isActive: order.isActive,
    })),
    creditCount: 0,
    credits: [],
  };
}

async function fetchRemoteMarketUniverse(): Promise<MarketUniverse> {
  const response = await fetch("/api/markets");
  if (!response.ok) {
    throw new Error(`Read API returned ${response.status} for /markets`);
  }

  const data = await response.json() as {
    asOf: number;
    tickerSnapshots: TickerSnapshot[];
    marketsByTicker: Record<Ticker, Array<Omit<MarketRecord, "publicKey" | "yesMint" | "noMint" | "vault" | "orderBook"> & {
      publicKey: string;
      yesMint: string;
      noMint: string;
      vault: string;
      orderBook: Parameters<typeof deserializeOrderBook>[0];
    }>>;
  };

  const marketsByTicker = Object.fromEntries(
    Object.entries(data.marketsByTicker).map(([ticker, markets]) => [
      ticker,
      markets.map((market) => ({
        ...market,
        publicKey: new PublicKey(market.publicKey),
        yesMint: new PublicKey(market.yesMint),
        noMint: new PublicKey(market.noMint),
        vault: new PublicKey(market.vault),
        orderBook: deserializeOrderBook(market.orderBook),
      })),
    ])
  ) as Record<Ticker, MarketRecord[]>;

  return {
    asOf: data.asOf,
    tickerSnapshots: data.tickerSnapshots,
    marketsByTicker,
  };
}

export async function fetchMarketUniverse(): Promise<MarketUniverse> {
  const now = Date.now();
  if (marketUniverseCache && now - marketUniverseCacheAt < Math.max(5_000, MARKET_POLL_MS / 2)) {
    return marketUniverseCache;
  }
  if (marketUniverseInflight) return marketUniverseInflight;

  marketUniverseInflight = (async () => {
  try {
    return await fetchRemoteMarketUniverse();
  } catch (error) {
    console.warn("/api/markets failed, falling back to direct RPC:", error);
  }

  const program = getReadOnlyProgram();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawMarkets = await (program.account as any).strikeMarket.all();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalized: NormalizedMarketBase[] = rawMarkets.map((item: any) => ({
    address: item.publicKey.toBase58(),
    publicKey: item.publicKey as PublicKey,
    ticker: item.account.ticker as Ticker,
    company: MAG7.find((entry) => entry.ticker === item.account.ticker)?.name ?? item.account.ticker,
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
    settlementSource: item.account.settlementSource ? decodeEnum(item.account.settlementSource) : null,
  }));

  const latestDates = latestDateByTicker(normalized);
  const activeSet = normalized.filter(
    (item: NormalizedMarketBase) => latestDates.get(item.ticker) === item.date
  );

  const orderBookAddresses = activeSet.map((item: NormalizedMarketBase) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), item.publicKey.toBuffer()],
      PROGRAM_ID
    )[0]
  );
  const orderBookAccounts = orderBookAddresses.length
    ? await connection.getMultipleAccountsInfo(orderBookAddresses)
    : [];

  const prices = await fetchPrices(MAG7.map((entry) => entry.pythFeedId));
  const marketsByTicker = Object.fromEntries(
    MAG7.map((entry) => [entry.ticker, [] as MarketRecord[]])
  ) as Record<Ticker, MarketRecord[]>;

  activeSet.forEach((item: NormalizedMarketBase, index: number) => {
    const bookAccount = orderBookAccounts[index];
    const orderBook = bookAccount ? parseOrderBook(bookAccount) : null;
    const bestBid = orderBook?.bids[0]?.price ?? null;
    const bestAsk = orderBook?.asks[0]?.price ?? null;
    const yesMid = bestBid != null && bestAsk != null
      ? Math.round((bestBid + bestAsk) / 2)
      : null;
    const bestNoBid = bestAsk != null ? USDC_PER_PAIR - bestAsk : null;
    const bestNoAsk = bestBid != null ? USDC_PER_PAIR - bestBid : null;
    const totalDepth = orderBook
      ? orderBook.bids.reduce((sum, order) => sum + order.quantity, 0) +
        orderBook.asks.reduce((sum, order) => sum + order.quantity, 0)
      : 0;

    marketsByTicker[item.ticker].push({
      ...item,
      bestBid,
      bestAsk,
      bestNoBid,
      bestNoAsk,
      yesMid,
      totalDepth,
      orderBook,
    });
  });

  for (const ticker of MAG7.map((entry) => entry.ticker)) {
    marketsByTicker[ticker].sort((a, b) => a.strikePrice - b.strikePrice);
  }

  const tickerSnapshots = MAG7.map((entry) => {
    const feedId = entry.pythFeedId.replace("0x", "");
    const price = prices.get(feedId);
    const markets = marketsByTicker[entry.ticker];
    const activeMarketCount = markets.filter((market) => market.status !== "settled").length;
    const created = markets.find((market) => market.status === "created");
    const frozen = markets.find((market) => market.status === "frozen");
    const settled = markets.find((market) => market.status === "settled");
    const representativeStatus = created?.status ?? frozen?.status ?? settled?.status ?? "idle";

    const rankedByDistance = [...markets].sort((a, b) => {
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
      marketCount: markets.length,
      activeMarketCount,
      topYesMid: rankedByDistance[0]?.yesMid ?? null,
      totalOpenInterest: markets.reduce((sum, market) => sum + market.totalPairsMinted, 0),
      nearestStrike: markets.length
        ? [...markets].sort((a, b) => {
            const fallback = markets[0].strikePrice / USDC_PER_PAIR;
            const ref = referencePrice ?? fallback;
            return Math.abs(a.strikePrice / USDC_PER_PAIR - ref) - Math.abs(b.strikePrice / USDC_PER_PAIR - ref);
          })[0].strikePrice
        : null,
      status: representativeStatus,
    } satisfies TickerSnapshot;
  });

  const next = {
    asOf: Date.now(),
    tickerSnapshots,
    marketsByTicker,
  };
    marketUniverseCache = next;
    marketUniverseCacheAt = Date.now();
    return next;
  })();

  try {
    return await marketUniverseInflight;
  } finally {
    marketUniverseInflight = null;
  }
}

export function useMarketUniverse(pollMs = MARKET_POLL_MS) {
  const [data, setData] = useState<MarketUniverse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    async function load() {
      if (document.visibilityState === "hidden") return;
      try {
        const next = await fetchMarketUniverse();
        if (!alive) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Failed to load markets");
      } finally {
        if (alive) setLoading(false);
      }
    }

    load();
    const id = window.setInterval(load, pollMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pollMs]);

  const stats = useMemo(() => {
    const snapshots = data?.tickerSnapshots ?? [];
    return {
      activeTickers: snapshots.filter((item) => item.marketCount > 0).length,
      totalMarkets: snapshots.reduce((sum, item) => sum + item.marketCount, 0),
      totalOpenInterest: snapshots.reduce((sum, item) => sum + item.totalOpenInterest, 0),
    };
  }, [data]);

  return { data, error, loading, stats };
}
