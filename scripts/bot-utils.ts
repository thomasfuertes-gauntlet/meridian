/**
 * Shared utilities for bot scripts (live-bots, strategy-bots, seed-bots).
 * Order book parsing, market discovery, USDC mint loading, common helpers.
 */
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, Connection, Transaction, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// --- Order book binary layout constants ---
// Must match programs/meridian/src/state/orderbook.rs layout
const DISC = 8;
const HEADER = 112;
const ORDER_SZ = 72;
export const MAX_PER_SIDE = 32;

export interface Order {
  owner: PublicKey;
  price: number;
  quantity: number;
  orderId: number;
  isActive: boolean;
}

export interface Book {
  bidCount: number;
  askCount: number;
  bids: Order[];
  asks: Order[];
}

const CREDIT_ENTRY_SZ = 48;
const MAX_CREDIT_ENTRIES = 64;

export function parseBook(data: Buffer): Book {
  const expectedSize = DISC + HEADER + 2 * MAX_PER_SIDE * ORDER_SZ + MAX_CREDIT_ENTRIES * CREDIT_ENTRY_SZ;
  if (data.length < expectedSize) {
    return { bidCount: 0, askCount: 0, bids: [], asks: [] };
  }
  const base = DISC;
  const bidCount = data.readUInt16LE(base + 104);
  const askCount = data.readUInt16LE(base + 106);
  const bidsOff = base + HEADER;
  const asksOff = bidsOff + MAX_PER_SIDE * ORDER_SZ;

  const readOrder = (off: number): Order => ({
    owner: new PublicKey(data.subarray(off, off + 32)),
    price: Number(data.readBigUInt64LE(off + 32)),
    quantity: Number(data.readBigUInt64LE(off + 40)),
    orderId: Number(data.readBigUInt64LE(off + 56)),
    isActive: data[off + 64] === 1,
  });

  const bids: Order[] = [];
  for (let i = 0; i < MAX_PER_SIDE; i++) {
    const o = readOrder(bidsOff + i * ORDER_SZ);
    if (o.isActive) bids.push(o);
  }
  const asks: Order[] = [];
  for (let i = 0; i < MAX_PER_SIDE; i++) {
    const o = readOrder(asksOff + i * ORDER_SZ);
    if (o.isActive) asks.push(o);
  }
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return { bidCount, askCount, bids, asks };
}

// ParsedOrder is an alias for Order - same shape, used where frontend calls ParsedOrder
export type ParsedOrder = Order;

// --- Market context ---

export interface MarketCtx {
  pubkey: PublicKey;
  ticker: string;
  strikePrice: number; // USDC base units
  closeTime: number;   // Unix seconds
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  orderBook: PublicKey;
  obUsdcVault: PublicKey;
  obYesVault: PublicKey;
}

export function getBotTickerFilter(): string {
  const ticker = process.env.DEMO_TICKER?.trim().toUpperCase();
  return ticker || "NVDA";
}

function marketRecordToCtx(m: { address: string; ticker: string; strikePrice: number; closeTime: number }, pid: PublicKey): MarketCtx {
  const pk = new PublicKey(m.address);
  return {
    pubkey: pk,
    ticker: m.ticker,
    strikePrice: m.strikePrice,
    closeTime: m.closeTime,
    yesMint: PublicKey.findProgramAddressSync([Buffer.from("yes_mint"), pk.toBuffer()], pid)[0],
    noMint: PublicKey.findProgramAddressSync([Buffer.from("no_mint"), pk.toBuffer()], pid)[0],
    vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), pk.toBuffer()], pid)[0],
    orderBook: PublicKey.findProgramAddressSync([Buffer.from("orderbook"), pk.toBuffer()], pid)[0],
    obUsdcVault: PublicKey.findProgramAddressSync([Buffer.from("ob_usdc_vault"), pk.toBuffer()], pid)[0],
    obYesVault: PublicKey.findProgramAddressSync([Buffer.from("ob_yes_vault"), pk.toBuffer()], pid)[0],
  };
}

/** Discover all active (pending) markets via direct RPC. */
export async function discoverMarkets(program: Program<Meridian>): Promise<MarketCtx[]> {
  const pid = program.programId;
  const demoTicker = getBotTickerFilter();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return allMarkets
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => m.account.outcome?.pending !== undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => !demoTicker || (m.account.ticker as string).toUpperCase() === demoTicker)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((m: any) => marketRecordToCtx({ address: m.publicKey.toBase58(), ticker: m.account.ticker, strikePrice: m.account.strikePrice.toNumber(), closeTime: m.account.closeTime.toNumber() }, pid));
}

// --- Config loading ---

export function loadUsdcMint(): PublicKey {
  let usdcMintStr = process.env.USDC_MINT;
  if (!usdcMintStr) {
    const configPath = path.join(import.meta.dirname, "../frontend/src/lib/local-config.json");
    if (!fs.existsSync(configPath)) {
      console.error("USDC mint not found. Set USDC_MINT env var or run `make setup`.");
      process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    usdcMintStr = config.usdcMint;
  }
  return new PublicKey(usdcMintStr!);
}

// --- Common helpers ---

export { USDC_PER_PAIR } from "./constants";

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when RPC is not localhost (devnet/mainnet - rate-limited) */
export function isRemoteRpc(): boolean {
  const url = process.env.ANCHOR_PROVIDER_URL || process.env.RPC_URL || "";
  return !url.includes("localhost") && !url.includes("127.0.0.1");
}

/**
 * Default TX delay based on RPC target. Single source of truth for all scripts.
 * Helius free tier enforces ~1s debounce per transaction. We use 2500ms to leave
 * headroom when multiple scripts share the same endpoint (live-bots + strategy-bots).
 * Override with TX_DELAY_MS env var. Local validator needs no delay.
 */
export function defaultTxDelay(): number {
  return Number(process.env.TX_DELAY_MS ?? (isRemoteRpc() ? 2500 : 0));
}

const ACTIVE_MARKET_FILE = "/tmp/meridian-active-market.txt";
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface ActiveMarket {
  ticker: string;
  marketAddress: string | null;
}

/**
 * Read the active market signal from env or file.
 * Supports `ticker:address` format; if no colon, treats as ticker-only.
 * File signal is considered stale if mtime > 5 min and returns null.
 */
export function getActiveMarket(): ActiveMarket | null {
  // Env var override takes priority (ACTIVE_MARKET=ticker:address or just ticker)
  const envVal = process.env.ACTIVE_MARKET?.trim();
  if (envVal) {
    const colonIdx = envVal.indexOf(":");
    if (colonIdx >= 0) {
      return { ticker: envVal.slice(0, colonIdx).toUpperCase(), marketAddress: envVal.slice(colonIdx + 1) };
    }
    return { ticker: envVal.toUpperCase(), marketAddress: null };
  }

  // File signal (written by frontend dev server middleware)
  try {
    const stat = fs.statSync(ACTIVE_MARKET_FILE);
    if (Date.now() - stat.mtimeMs > STALE_THRESHOLD_MS) return null; // stale
    const content = fs.readFileSync(ACTIVE_MARKET_FILE, "utf-8").trim();
    if (!content) return null;
    const colonIdx = content.indexOf(":");
    if (colonIdx >= 0) {
      return { ticker: content.slice(0, colonIdx).toUpperCase(), marketAddress: content.slice(colonIdx + 1) };
    }
    return { ticker: content.toUpperCase(), marketAddress: null };
  } catch {
    return null;
  }
}

/** @deprecated Use getActiveMarket() instead. Kept for backwards compat. */
export function getActiveTicker(): string | null {
  return getActiveMarket()?.ticker ?? null;
}

/**
 * Select markets weighted toward the active market signal.
 * If active market has a specific address: 80% weight on that exact strike.
 * If active market is ticker-only: 80% weight on all markets for that ticker.
 * Falls back to uniform random if no signal or no matching markets.
 */
// --- RPC credit optimization helpers ---
// KEY-DECISION 2026-03-14: Helius free tier = 1M credits/mo. Each
// sendAndConfirmTransaction costs ~3 credits (blockhash + send + confirm).
// Caching blockhash + fire-and-forget + batch confirm cuts to ~1 credit/tx.

let _cachedBlockhash: { blockhash: string; lastValidBlockHeight: number; fetchedAt: number } | null = null;
const BLOCKHASH_CACHE_MS = 30_000; // 30s (valid ~60-90s on-chain)

/**
 * Cached getLatestBlockhash. Reuses for 30s to avoid 1 credit per tx.
 * Single biggest optimization: 54k credits/day → ~2k.
 */
export async function getBlockhashCached(
  connection: Connection,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  if (_cachedBlockhash && Date.now() - _cachedBlockhash.fetchedAt < BLOCKHASH_CACHE_MS) {
    return _cachedBlockhash;
  }
  const bh = await connection.getLatestBlockhash();
  _cachedBlockhash = { ...bh, fetchedAt: Date.now() };
  return bh;
}

/**
 * Send a signed transaction without simulation or confirmation.
 * 1 RPC call instead of 3. Callers collect sigs and batch-confirm later.
 */
export async function sendNoConfirm(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  blockhashInfo?: { blockhash: string; lastValidBlockHeight: number },
): Promise<string> {
  const bh = blockhashInfo ?? await getBlockhashCached(connection);
  tx.recentBlockhash = bh.blockhash;
  tx.lastValidBlockHeight = bh.lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  return connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 2,
  });
}

/**
 * Batch-confirm an array of signatures. Polls getSignatureStatuses
 * (up to 256 sigs per call, 1 credit each) until all resolve or timeout.
 */
export async function batchConfirm(
  connection: Connection,
  sigs: string[],
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<{ confirmed: number; failed: number }> {
  if (sigs.length === 0) return { confirmed: 0, failed: 0 };
  const { timeoutMs = 60_000, pollIntervalMs = 3000 } = opts;
  const startMs = Date.now();
  const resolved = new Map<number, boolean>(); // index -> success

  while (resolved.size < sigs.length && Date.now() - startMs < timeoutMs) {
    const unresolved = sigs
      .map((sig, i) => ({ sig, i }))
      .filter(({ i }) => !resolved.has(i));

    for (let batch = 0; batch < unresolved.length; batch += 256) {
      const chunk = unresolved.slice(batch, batch + 256);
      const statuses = await connection.getSignatureStatuses(
        chunk.map((c) => c.sig),
      );
      for (let j = 0; j < chunk.length; j++) {
        const status = statuses.value[j];
        if (!status) continue; // not yet processed
        resolved.set(chunk[j].i, !status.err);
      }
    }

    if (resolved.size < sigs.length) {
      await sleep(pollIntervalMs);
    }
  }

  let confirmed = 0;
  let failed = 0;
  for (let i = 0; i < sigs.length; i++) {
    if (resolved.get(i)) confirmed++;
    else failed++;
  }
  return { confirmed, failed };
}

export function weightedMarketSelect(markets: MarketCtx[], count: number): MarketCtx[] {
  const activeMarket = getActiveMarket();
  if (!activeMarket || count >= markets.length) {
    return [...markets].sort(() => Math.random() - 0.5).slice(0, count);
  }
  const active = activeMarket.marketAddress
    ? markets.filter((m) => m.pubkey.toBase58() === activeMarket.marketAddress)
    : markets.filter((m) => m.ticker === activeMarket.ticker);
  const rest = markets.filter((m) => !active.includes(m));
  if (active.length === 0) {
    return [...markets].sort(() => Math.random() - 0.5).slice(0, count);
  }
  const selected: MarketCtx[] = [];
  for (let i = 0; i < count; i++) {
    const pool = Math.random() < 0.8 && active.length > 0 ? active : rest.length > 0 ? rest : active;
    selected.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return selected;
}
