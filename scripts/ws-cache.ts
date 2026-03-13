/**
 * Shared WebSocket subscription cache for bot scripts.
 * Subscribes to orderbook and market account changes via onAccountChange,
 * eliminating poll-based RPC reads that trigger 429s on devnet.
 *
 * Usage:
 *   const cache = createWsCache(connection, program);
 *   await cache.ready;
 *   const book = cache.books.get(mkt.orderBook.toBase58());
 *   const markets = [...cache.markets.values()];
 *   cache.close(); // on shutdown
 */
import { Connection } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { MarketCtx, Book, parseBook, discoverMarkets } from "./bot-utils";

export interface WsCache {
  markets: Map<string, MarketCtx>;
  books: Map<string, Book>;
  ready: Promise<void>;
  close(): void;
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // re-discover new markets every 5 min

export function createWsCache(connection: Connection, program: Program<Meridian>): WsCache {
  const markets = new Map<string, MarketCtx>();
  const books = new Map<string, Book>();
  const listeners: number[] = [];

  function subscribeOrderBook(mkt: MarketCtx) {
    const obKey = mkt.orderBook.toBase58();
    const id = connection.onAccountChange(
      mkt.orderBook,
      (accountInfo) => {
        books.set(obKey, parseBook(accountInfo.data as Buffer));
      },
      "confirmed",
    );
    listeners.push(id);
  }

  function subscribeMarket(mkt: MarketCtx) {
    const marketKey = mkt.pubkey.toBase58();
    const id = connection.onAccountChange(
      mkt.pubkey,
      (accountInfo) => {
        try {
          const decoded = program.coder.accounts.decode("strikeMarket", accountInfo.data);
          if (decoded.outcome?.pending === undefined) {
            // Market settled or frozen into terminal state - remove from active maps
            markets.delete(marketKey);
            books.delete(mkt.orderBook.toBase58());
          }
        } catch {
          // ignore decode errors - account may have been closed
        }
      },
      "confirmed",
    );
    listeners.push(id);
  }

  async function subscribeNewMarket(mkt: MarketCtx) {
    markets.set(mkt.pubkey.toBase58(), mkt);

    // Fetch initial book state before WS catches up
    try {
      const obInfo = await connection.getAccountInfo(mkt.orderBook);
      if (obInfo) {
        books.set(mkt.orderBook.toBase58(), parseBook(obInfo.data as Buffer));
      }
    } catch {
      // Non-fatal: WS will populate once first change arrives
    }

    subscribeOrderBook(mkt);
    subscribeMarket(mkt);
  }

  async function bootstrap() {
    const discovered = await discoverMarkets(program);
    for (const mkt of discovered) {
      await subscribeNewMarket(mkt);
    }
  }

  const ready = bootstrap();

  // Periodic refresh to discover newly created markets
  const refreshInterval = setInterval(async () => {
    try {
      const discovered = await discoverMarkets(program);
      for (const mkt of discovered) {
        if (!markets.has(mkt.pubkey.toBase58())) {
          await subscribeNewMarket(mkt);
        }
      }
    } catch {
      // ignore - will retry next interval
    }
  }, REFRESH_INTERVAL_MS);

  function close() {
    clearInterval(refreshInterval);
    for (const id of listeners) {
      connection.removeAccountChangeListener(id).catch(() => {});
    }
    listeners.length = 0;
  }

  return { markets, books, ready, close };
}
