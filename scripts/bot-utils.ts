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

/** Discover all active (pending) NVDA markets via direct RPC. */
export async function discoverMarkets(program: Program<Meridian>): Promise<MarketCtx[]> {
  const pid = program.programId;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return allMarkets
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => m.account.outcome?.pending !== undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => (m.account.ticker as string).toUpperCase() === "NVDA")
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
 * Helius Developer plan ($49/mo): 50 req/s, 10M credits/mo. With fire-and-forget
 * (1 RPC call/tx), 500ms spacing = 2 tx/s, well under 50 req/s even with
 * concurrent bot processes. Override with TX_DELAY_MS env var.
 */
export function defaultTxDelay(): number {
  return Number(process.env.TX_DELAY_MS ?? (isRemoteRpc() ? 500 : 0));
}

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

