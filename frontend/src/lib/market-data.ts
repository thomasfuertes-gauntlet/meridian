import { PublicKey } from "@solana/web3.js";
import type { Ticker } from "./constants";
import type { ParsedOrderBook } from "./orderbook";

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
