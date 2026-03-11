/**
 * Shared utilities for bot scripts (live-bots, strategy-bots, seed-bots).
 * Order book parsing, market discovery, USDC mint loading, common helpers.
 */
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
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

export function parseBook(data: Buffer): Book {
  const expectedSize = DISC + HEADER + 2 * MAX_PER_SIDE * ORDER_SZ;
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

/** Discover all active (pending) markets and derive their PDAs. */
export async function discoverMarkets(program: Program<Meridian>): Promise<MarketCtx[]> {
  const pid = program.programId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return allMarkets
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => m.account.outcome?.pending !== undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((m: any) => {
      const pk: PublicKey = m.publicKey;
      return {
        pubkey: pk,
        ticker: m.account.ticker as string,
        strikePrice: m.account.strikePrice.toNumber(),
        closeTime: m.account.closeTime.toNumber(),
        yesMint: PublicKey.findProgramAddressSync([Buffer.from("yes_mint"), pk.toBuffer()], pid)[0],
        noMint: PublicKey.findProgramAddressSync([Buffer.from("no_mint"), pk.toBuffer()], pid)[0],
        vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), pk.toBuffer()], pid)[0],
        orderBook: PublicKey.findProgramAddressSync([Buffer.from("orderbook"), pk.toBuffer()], pid)[0],
        obUsdcVault: PublicKey.findProgramAddressSync([Buffer.from("ob_usdc_vault"), pk.toBuffer()], pid)[0],
        obYesVault: PublicKey.findProgramAddressSync([Buffer.from("ob_yes_vault"), pk.toBuffer()], pid)[0],
      };
    });
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

export const USDC_PER_PAIR = 1_000_000;

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const ACTIVE_MARKET_FILE = "/tmp/meridian-active-market.txt";

/** Read the active ticker from env or file signal. Returns null if none set. */
export function getActiveTicker(): string | null {
  if (process.env.ACTIVE_TICKER) return process.env.ACTIVE_TICKER;
  try {
    return fs.readFileSync(ACTIVE_MARKET_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Select markets weighted toward the active ticker.
 * 80% chance of picking from active ticker's markets, 20% from the rest.
 * Falls back to uniform random if no active ticker or no matching markets.
 */
export function weightedMarketSelect(markets: MarketCtx[], count: number): MarketCtx[] {
  const activeTicker = getActiveTicker();
  if (!activeTicker || count >= markets.length) {
    return [...markets].sort(() => Math.random() - 0.5).slice(0, count);
  }
  const active = markets.filter((m) => m.ticker === activeTicker);
  const rest = markets.filter((m) => m.ticker !== activeTicker);
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
