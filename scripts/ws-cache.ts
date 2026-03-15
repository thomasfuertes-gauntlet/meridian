/**
 * Shared WebSocket subscription cache for bot scripts.
 *
 * Subscribes to one orderbook at a time via onAccountChange (1 WS sub).
 * Cycles through discovered markets round-robin every 10s.
 * Writes parsed book state to a tmpfile so other processes (strategy-bots) can
 * read without their own WS connections. Fits within Helius free-tier 5 WS limit.
 *
 * Usage (owner - live-bots):
 *   const cache = createWsCache(connection, program);
 *   await cache.ready;
 *   const book = cache.books.get(obKey);
 *
 * Usage (reader - strategy-bots):
 *   import { loadSharedBooks } from "./ws-cache";
 *   const books = loadSharedBooks();
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { MarketCtx, Book, Order, parseBook, discoverMarkets } from "./bot-utils";
import { writeFileSync, readFileSync } from "node:fs";

export interface WsCache {
  markets: Map<string, MarketCtx>;
  books: Map<string, Book>;
  ready: Promise<void>;
  close(): void;
}

const STATE_FILE = "/tmp/meridian-ws-books.json";
const ROTATE_INTERVAL_MS = 10_000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// If no WS callback fires within this window, treat the subscription as silently dead
// and re-subscribe. Public devnet RPC silently drops WS connections; Helius is reliable.
const WS_LIVENESS_MS = 2 * 60 * 1000;

interface SerializedOrder {
  owner: string;
  price: number;
  quantity: number;
  orderId: number;
  isActive: boolean;
}

interface SerializedBook {
  bidCount: number;
  askCount: number;
  bids: SerializedOrder[];
  asks: SerializedOrder[];
}

function serializeBooks(books: Map<string, Book>): Record<string, SerializedBook> {
  const out: Record<string, SerializedBook> = {};
  for (const [key, book] of books) {
    out[key] = {
      bidCount: book.bidCount,
      askCount: book.askCount,
      bids: book.bids.map((o) => ({ owner: o.owner.toBase58(), price: o.price, quantity: o.quantity, orderId: o.orderId, isActive: o.isActive })),
      asks: book.asks.map((o) => ({ owner: o.owner.toBase58(), price: o.price, quantity: o.quantity, orderId: o.orderId, isActive: o.isActive })),
    };
  }
  return out;
}

function deserializeOrder(o: SerializedOrder): Order {
  return { owner: new PublicKey(o.owner), price: o.price, quantity: o.quantity, orderId: o.orderId, isActive: o.isActive };
}

/**
 * Read shared book state written by the WS cache owner process.
 * Safe to call from any process - returns empty map if file missing/stale.
 */
export function loadSharedBooks(): Map<string, Book> {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as Record<string, SerializedBook>;
    const books = new Map<string, Book>();
    for (const [key, sb] of Object.entries(raw)) {
      books.set(key, {
        bidCount: sb.bidCount,
        askCount: sb.askCount,
        bids: sb.bids.map(deserializeOrder),
        asks: sb.asks.map(deserializeOrder),
      });
    }
    return books;
  } catch {
    return new Map();
  }
}

function writeState(books: Map<string, Book>) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(serializeBooks(books)), "utf-8");
  } catch {
    // Non-fatal: reader will use stale data
  }
}

export function createWsCache(connection: Connection, program: Program<Meridian>): WsCache {
  const markets = new Map<string, MarketCtx>();
  const books = new Map<string, Book>();
  let activeSubId: number | null = null;
  let activeObKey: string | null = null;
  let lastWsCallbackAt: number = Date.now();

  function subscribeOrderBook(mkt: MarketCtx) {
    const obKey = mkt.orderBook.toBase58();
    if (obKey === activeObKey) return; // already subscribed

    // Unsub previous
    if (activeSubId !== null) {
      connection.removeAccountChangeListener(activeSubId).catch(() => {});
      activeSubId = null;
    }

    activeObKey = obKey;
    lastWsCallbackAt = Date.now();
    activeSubId = connection.onAccountChange(
      mkt.orderBook,
      (accountInfo) => {
        lastWsCallbackAt = Date.now();
        books.set(obKey, parseBook(accountInfo.data as Buffer));
        writeState(books);
      },
      "confirmed",
    );
  }

  /**
   * Re-subscribe if WS has been silent too long. Public devnet RPC silently drops
   * WS connections after a period; this detects the stale sub and forces a new one.
   * Clearing activeObKey bypasses the dedup guard so subscribeOrderBook re-registers.
   */
  function checkWsLiveness() {
    if (activeObKey !== null && Date.now() - lastWsCallbackAt > WS_LIVENESS_MS) {
      console.warn("[ws-cache] WS subscription silent for >2min, re-subscribing");
      if (activeSubId !== null) {
        connection.removeAccountChangeListener(activeSubId).catch(() => {});
        activeSubId = null;
      }
      activeObKey = null;
      rotateActiveSubscription();
    }
  }

  function rotateActiveSubscription() {
    // Cycle through markets sequentially (round-robin)
    const all = [...markets.values()];
    if (all.length === 0) return;
    const currentIdx = activeObKey ? all.findIndex((m) => m.orderBook.toBase58() === activeObKey) : -1;
    const nextIdx = (currentIdx + 1) % all.length;
    subscribeOrderBook(all[nextIdx]);
  }

  async function bootstrap() {
    const discovered = await discoverMarkets(program);
    for (const mkt of discovered) {
      markets.set(mkt.pubkey.toBase58(), mkt);
      // Fetch initial book state via RPC (one-time)
      try {
        const obInfo = await connection.getAccountInfo(mkt.orderBook);
        if (obInfo) books.set(mkt.orderBook.toBase58(), parseBook(obInfo.data as Buffer));
      } catch {
        // Non-fatal: WS will populate for active market
      }
    }
    rotateActiveSubscription();
    writeState(books);
  }

  const ready = bootstrap();

  // Rotate WS sub round-robin every 10s; also check liveness to detect
  // silently dropped WS connections (common on public devnet RPC).
  const rotateInterval = setInterval(() => {
    checkWsLiveness();
    rotateActiveSubscription();
  }, ROTATE_INTERVAL_MS);

  // Discover new markets periodically
  const refreshInterval = setInterval(async () => {
    try {
      const discovered = await discoverMarkets(program);
      for (const mkt of discovered) {
        if (!markets.has(mkt.pubkey.toBase58())) {
          markets.set(mkt.pubkey.toBase58(), mkt);
          // Fetch initial book
          try {
            const obInfo = await connection.getAccountInfo(mkt.orderBook);
            if (obInfo) books.set(mkt.orderBook.toBase58(), parseBook(obInfo.data as Buffer));
          } catch {}
        }
      }
      writeState(books);
    } catch {
      // ignore - will retry next interval
    }
  }, REFRESH_INTERVAL_MS);

  function close() {
    clearInterval(rotateInterval);
    clearInterval(refreshInterval);
    if (activeSubId !== null) {
      connection.removeAccountChangeListener(activeSubId).catch(() => {});
    }
  }

  return { markets, books, ready, close };
}
