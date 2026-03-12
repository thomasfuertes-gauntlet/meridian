import { type AccountInfo, PublicKey } from "@solana/web3.js";

// Mirrors programs/meridian/src/state/orderbook.rs repr(C) layout
// Total size: 8 (discriminator) + 7792 = 7800 bytes

const DISCRIMINATOR_SIZE = 8;
const HEADER_SIZE = 112; // market(32) + ob_usdc_vault(32) + ob_yes_vault(32) + next_order_id(8) + bid_count(2) + ask_count(2) + bump(1) + credit_count(1) + padding(2)
const ORDER_SIZE = 72; // owner(32) + price(8) + quantity(8) + timestamp(8) + order_id(8) + is_active(1) + padding(7)
const MAX_ORDERS_PER_SIDE = 32;
const CREDIT_ENTRY_SIZE = 48; // owner(32) + usdc_claimable(8) + yes_claimable(8)
export const MAX_CREDIT_ENTRIES = 64;

export interface ParsedOrder {
  owner: PublicKey;
  price: number; // USDC base units (0-1_000_000)
  quantity: number;
  timestamp: number;
  orderId: number;
  isActive: boolean;
}

export interface ParsedCreditEntry {
  owner: PublicKey;
  usdcClaimable: number;
  yesClaimable: number;
}

export interface ParsedOrderBook {
  market: PublicKey;
  obUsdcVault: PublicKey;
  obYesVault: PublicKey;
  nextOrderId: number;
  bidCount: number;
  askCount: number;
  bump: number;
  creditCount: number;
  bids: ParsedOrder[];
  asks: ParsedOrder[];
  credits: ParsedCreditEntry[];
}

function parseOrder(buf: Buffer, offset: number): ParsedOrder {
  const owner = new PublicKey(buf.subarray(offset, offset + 32));
  const price = Number(buf.readBigUInt64LE(offset + 32));
  const quantity = Number(buf.readBigUInt64LE(offset + 40));
  const timestamp = Number(buf.readBigInt64LE(offset + 48));
  const orderId = Number(buf.readBigUInt64LE(offset + 56));
  const isActive = buf[offset + 64] === 1;
  return { owner, price, quantity, timestamp, orderId, isActive };
}

function parseCreditEntry(buf: Buffer, offset: number): ParsedCreditEntry {
  const owner = new PublicKey(buf.subarray(offset, offset + 32));
  const usdcClaimable = Number(buf.readBigUInt64LE(offset + 32));
  const yesClaimable = Number(buf.readBigUInt64LE(offset + 40));
  return { owner, usdcClaimable, yesClaimable };
}

export function parseOrderBook(
  account: AccountInfo<Buffer>
): ParsedOrderBook {
  const buf = account.data;
  const base = DISCRIMINATOR_SIZE;

  const market = new PublicKey(buf.subarray(base, base + 32));
  const obUsdcVault = new PublicKey(buf.subarray(base + 32, base + 64));
  const obYesVault = new PublicKey(buf.subarray(base + 64, base + 96));
  const nextOrderId = Number(buf.readBigUInt64LE(base + 96));
  const bidCount = buf.readUInt16LE(base + 104);
  const askCount = buf.readUInt16LE(base + 106);
  const bump = buf[base + 108];
  const creditCount = buf[base + 109];

  const bidsOffset = base + HEADER_SIZE;
  const asksOffset = bidsOffset + MAX_ORDERS_PER_SIDE * ORDER_SIZE;
  const creditsOffset = asksOffset + MAX_ORDERS_PER_SIDE * ORDER_SIZE;

  const bids: ParsedOrder[] = [];
  for (let i = 0; i < MAX_ORDERS_PER_SIDE; i++) {
    const order = parseOrder(buf, bidsOffset + i * ORDER_SIZE);
    if (order.isActive) bids.push(order);
  }

  const asks: ParsedOrder[] = [];
  for (let i = 0; i < MAX_ORDERS_PER_SIDE; i++) {
    const order = parseOrder(buf, asksOffset + i * ORDER_SIZE);
    if (order.isActive) asks.push(order);
  }

  const credits: ParsedCreditEntry[] = [];
  for (let i = 0; i < creditCount; i++) {
    const entry = parseCreditEntry(buf, creditsOffset + i * CREDIT_ENTRY_SIZE);
    if (entry.usdcClaimable > 0 || entry.yesClaimable > 0) {
      credits.push(entry);
    }
  }

  // Sort: bids highest first, asks lowest first
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  return {
    market,
    obUsdcVault,
    obYesVault,
    nextOrderId,
    bidCount,
    askCount,
    bump,
    creditCount,
    bids,
    asks,
    credits,
  };
}

// Flip the book to show No perspective
// No bid at price P = Yes ask at (1_000_000 - P)
// No ask at price P = Yes bid at (1_000_000 - P)
export function flipToNoPerspective(
  book: ParsedOrderBook
): { bids: ParsedOrder[]; asks: ParsedOrder[] } {
  const noBids = book.asks.map((a) => ({
    ...a,
    price: 1_000_000 - a.price,
  }));
  const noAsks = book.bids.map((b) => ({
    ...b,
    price: 1_000_000 - b.price,
  }));
  noBids.sort((a, b) => b.price - a.price);
  noAsks.sort((a, b) => a.price - b.price);
  return { bids: noBids, asks: noAsks };
}
