import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { parseOrderBook, flipToNoPerspective, type ParsedOrderBook, type ParsedOrder } from "./orderbook";

// Mirror constants from orderbook.ts to build test buffers
const DISC = 8;
const HEADER = 112;
const ORDER_SIZE = 72;
const SIDE_SIZE = 32 * ORDER_SIZE; // 2304
const CREDIT_SECTION = 64 * 48; // 3072
const TOTAL = DISC + HEADER + SIDE_SIZE * 2 + CREDIT_SECTION; // 7800

function makeEmptyBuffer(): Buffer {
  return Buffer.alloc(TOTAL);
}

// Write one order into the raw buffer at the given side/slot.
// Field layout: owner(32) price(8) qty(8) ts(8) orderId(8) isActive(1) pad(7)
function setOrder(
  buf: Buffer,
  side: "bid" | "ask",
  slot: number,
  opts: { price?: bigint; quantity?: bigint; orderId?: bigint; isActive?: boolean }
): void {
  const base = DISC + HEADER + (side === "ask" ? SIDE_SIZE : 0) + slot * ORDER_SIZE;
  if (opts.price !== undefined) buf.writeBigUInt64LE(opts.price, base + 32);
  if (opts.quantity !== undefined) buf.writeBigUInt64LE(opts.quantity, base + 40);
  buf.writeBigInt64LE(0n, base + 48); // timestamp
  if (opts.orderId !== undefined) buf.writeBigUInt64LE(opts.orderId, base + 56);
  if (opts.isActive !== undefined) buf[base + 64] = opts.isActive ? 1 : 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockAccountInfo(buf: Buffer): any {
  return { data: buf };
}

// Build a ParsedOrderBook directly for flipToNoPerspective tests (no buffer needed)
const dummyKey = new PublicKey(0);

function makeBook(bidPrices: number[], askPrices: number[]): ParsedOrderBook {
  const toOrder = (price: number, i: number): ParsedOrder => ({
    owner: dummyKey,
    price,
    quantity: 1,
    timestamp: 0,
    orderId: i + 1,
    isActive: true,
  });
  return {
    market: dummyKey,
    obUsdcVault: dummyKey,
    obYesVault: dummyKey,
    nextOrderId: bidPrices.length + askPrices.length + 1,
    bidCount: bidPrices.length,
    askCount: askPrices.length,
    bump: 0,
    creditCount: 0,
    bids: bidPrices.map(toOrder),
    asks: askPrices.map(toOrder),
    credits: [],
  };
}

// ── parseOrderBook ──────────────────────────────────────────────────────────

test("parseOrderBook: empty buffer yields zero active orders", () => {
  const book = parseOrderBook(mockAccountInfo(makeEmptyBuffer()));
  assert.equal(book.bids.length, 0);
  assert.equal(book.asks.length, 0);
  assert.equal(book.credits.length, 0);
});

test("parseOrderBook: single active bid is parsed correctly", () => {
  const buf = makeEmptyBuffer();
  setOrder(buf, "bid", 0, { price: 400_000n, quantity: 5n, orderId: 1n, isActive: true });
  const book = parseOrderBook(mockAccountInfo(buf));
  assert.equal(book.bids.length, 1);
  assert.equal(book.bids[0].price, 400_000);
  assert.equal(book.bids[0].quantity, 5);
  assert.equal(book.bids[0].orderId, 1);
  assert.equal(book.bids[0].isActive, true);
});

test("parseOrderBook: inactive orders are excluded", () => {
  const buf = makeEmptyBuffer();
  setOrder(buf, "bid", 0, { price: 300_000n, quantity: 2n, orderId: 1n, isActive: false });
  setOrder(buf, "bid", 1, { price: 400_000n, quantity: 3n, orderId: 2n, isActive: true });
  const book = parseOrderBook(mockAccountInfo(buf));
  assert.equal(book.bids.length, 1);
  assert.equal(book.bids[0].price, 400_000);
});

test("parseOrderBook: bids sorted highest-first, asks sorted lowest-first", () => {
  const buf = makeEmptyBuffer();
  setOrder(buf, "bid", 0, { price: 300_000n, quantity: 1n, orderId: 1n, isActive: true });
  setOrder(buf, "bid", 1, { price: 500_000n, quantity: 1n, orderId: 2n, isActive: true });
  setOrder(buf, "bid", 2, { price: 400_000n, quantity: 1n, orderId: 3n, isActive: true });
  setOrder(buf, "ask", 0, { price: 700_000n, quantity: 1n, orderId: 4n, isActive: true });
  setOrder(buf, "ask", 1, { price: 600_000n, quantity: 1n, orderId: 5n, isActive: true });

  const book = parseOrderBook(mockAccountInfo(buf));
  assert.equal(book.bids[0].price, 500_000);
  assert.equal(book.bids[1].price, 400_000);
  assert.equal(book.bids[2].price, 300_000);
  assert.equal(book.asks[0].price, 600_000);
  assert.equal(book.asks[1].price, 700_000);
});

test("parseOrderBook: handles full 32-order book on each side", () => {
  const buf = makeEmptyBuffer();
  for (let i = 0; i < 32; i++) {
    setOrder(buf, "bid", i, { price: BigInt(i * 10_000 + 50_000), quantity: 1n, orderId: BigInt(i + 1), isActive: true });
    setOrder(buf, "ask", i, { price: BigInt(i * 10_000 + 600_000), quantity: 1n, orderId: BigInt(i + 33), isActive: true });
  }
  const book = parseOrderBook(mockAccountInfo(buf));
  assert.equal(book.bids.length, 32);
  assert.equal(book.asks.length, 32);
});

// ── flipToNoPerspective ─────────────────────────────────────────────────────

test("flipToNoPerspective: empty book stays empty", () => {
  const { bids, asks } = flipToNoPerspective(makeBook([], []));
  assert.equal(bids.length, 0);
  assert.equal(asks.length, 0);
});

test("flipToNoPerspective: No bids come from Yes asks at inverted prices", () => {
  // Yes asks at 600k, 700k → No bids at 400k, 300k (sorted highest first)
  const { bids } = flipToNoPerspective(makeBook([], [600_000, 700_000]));
  assert.equal(bids.length, 2);
  assert.equal(bids[0].price, 400_000); // 1M - 600k
  assert.equal(bids[1].price, 300_000); // 1M - 700k
});

test("flipToNoPerspective: No asks come from Yes bids at inverted prices", () => {
  // Yes bids at 300k, 400k → No asks at 700k, 600k (sorted lowest first)
  const { asks } = flipToNoPerspective(makeBook([400_000, 300_000], []));
  assert.equal(asks.length, 2);
  assert.equal(asks[0].price, 600_000); // 1M - 400k
  assert.equal(asks[1].price, 700_000); // 1M - 300k
});

test("flipToNoPerspective: Yes bid + No ask prices sum to 1_000_000", () => {
  const yesBidPrice = 350_000;
  const { asks } = flipToNoPerspective(makeBook([yesBidPrice], []));
  assert.equal(asks[0].price + yesBidPrice, 1_000_000);
});

test("flipToNoPerspective: Yes ask + No bid prices sum to 1_000_000", () => {
  const yesAskPrice = 650_000;
  const { bids } = flipToNoPerspective(makeBook([], [yesAskPrice]));
  assert.equal(bids[0].price + yesAskPrice, 1_000_000);
});
