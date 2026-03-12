import "dotenv/config";

import { BorshInstructionCoder, AnchorProvider, type Idl, Program } from "@coral-xyz/anchor";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { PublicKey, Connection, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";

import { DEFAULT_FEED_IDS, fetchPrice } from "./pyth.js";

const PORT = Number(process.env.PORT || "8080");
const RPC_URL = process.env.ANCHOR_PROVIDER_URL || process.env.RPC_URL;
const COMMITMENT = "confirmed";
const RPC_GAP_MS = Number(process.env.READ_API_RPC_GAP_MS || "1100");
const MARKET_TTL_MS = Number(process.env.READ_API_MARKET_TTL_MS || "15000");
const ACTIVITY_TTL_MS = Number(process.env.READ_API_ACTIVITY_TTL_MS || "45000");
const MAX_ACTIVITY_LIMIT = Number(process.env.READ_API_MAX_ACTIVITY_LIMIT || "20");
const ACTIVITY_SIGNATURES_PER_MARKET = Number(process.env.READ_API_ACTIVITY_SIGNATURES_PER_MARKET || "1");
const USDC_PER_PAIR = 1_000_000;
const PROGRAM_ID = new PublicKey("GMwKXYNKRkN3wGdgAwR4BzG2RfPGGLGjehuoNwUzBGk2");

const idlPath = new URL("../../frontend/src/idl/meridian.json", import.meta.url);
const idl = JSON.parse(readFileSync(idlPath, "utf-8")) as Idl;

if (!RPC_URL) {
  throw new Error("ANCHOR_PROVIDER_URL or RPC_URL must be set for read-api");
}

const connection = new Connection(RPC_URL, COMMITMENT);
const provider = new AnchorProvider(connection, {} as never, {
  preflightCommitment: COMMITMENT,
  commitment: COMMITMENT,
});
const program = new Program(idl, provider);
const coder = new BorshInstructionCoder(idl);

const MAG7 = [
  { ticker: "AAPL", name: "Apple" },
  { ticker: "MSFT", name: "Microsoft" },
  { ticker: "GOOGL", name: "Alphabet" },
  { ticker: "AMZN", name: "Amazon" },
  { ticker: "NVDA", name: "NVIDIA" },
  { ticker: "META", name: "Meta Platforms" },
  { ticker: "TSLA", name: "Tesla" },
] as const;

type Ticker = (typeof MAG7)[number]["ticker"];
type MarketStatus = "created" | "frozen" | "settled";
type MarketOutcome = "pending" | "yesWins" | "noWins";

interface ParsedOrder {
  owner: string;
  price: number;
  quantity: number;
  timestamp: number;
  orderId: number;
  isActive: boolean;
}

interface ParsedOrderBook {
  market: string;
  obUsdcVault: string;
  obYesVault: string;
  nextOrderId: number;
  bidCount: number;
  askCount: number;
  bump: number;
  bids: ParsedOrder[];
  asks: ParsedOrder[];
}

interface MarketRecord {
  address: string;
  publicKey: string;
  ticker: Ticker;
  company: string;
  yesMint: string;
  noMint: string;
  vault: string;
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

interface TickerSnapshot {
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

interface MarketUniverse {
  asOf: number;
  tickerSnapshots: TickerSnapshot[];
  marketsByTicker: Record<Ticker, MarketRecord[]>;
}

type ActivityKind =
  | "mintPair"
  | "buyYes"
  | "sellYes"
  | "redeem"
  | "placeOrder"
  | "cancelOrder"
  | "freezeMarket"
  | "settleMarket"
  | "adminSettle"
  | "createMarket"
  | "unknown";

interface ActivityRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  success: boolean;
  instructionName: string;
  kind: ActivityKind;
  label: string;
  marketAddress: string | null;
  ticker: Ticker | null;
  strikePrice: number | null;
  user: string | null;
  side: "yes" | "no" | null;
  amount: number | null;
  price: number | null;
  minPrice: number | null;
  maxPrice: number | null;
}

interface MarketLookupEntry {
  address: string;
  ticker: Ticker;
  strikePrice: number;
  yesMint: string;
  noMint: string;
}

interface DecodedInstruction {
  name: string;
  data: Record<string, unknown>;
}

class RpcQueue {
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = 0;

  async run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const waitMs = Math.max(0, RPC_GAP_MS - (Date.now() - this.lastStartedAt));
      if (waitMs > 0) await sleep(waitMs);
      this.lastStartedAt = Date.now();
      return job();
    });

    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const rpcQueue = new RpcQueue();

function queued<T>(job: () => Promise<T>): Promise<T> {
  return rpcQueue.run(job);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(response: unknown, statusCode = 200) {
  return {
    statusCode,
    body: JSON.stringify(response),
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "public, max-age=5, stale-while-revalidate=25",
    },
  };
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

const DISCRIMINATOR_SIZE = 8;
const HEADER_SIZE = 112;
const ORDER_SIZE = 72;
const MAX_ORDERS_PER_SIDE = 32;

function parseOrder(buf: Buffer, offset: number): ParsedOrder {
  return {
    owner: new PublicKey(buf.subarray(offset, offset + 32)).toBase58(),
    price: Number(buf.readBigUInt64LE(offset + 32)),
    quantity: Number(buf.readBigUInt64LE(offset + 40)),
    timestamp: Number(buf.readBigInt64LE(offset + 48)),
    orderId: Number(buf.readBigUInt64LE(offset + 56)),
    isActive: buf[offset + 64] === 1,
  };
}

function parseOrderBook(accountData: Buffer): ParsedOrderBook {
  const base = DISCRIMINATOR_SIZE;
  const market = new PublicKey(accountData.subarray(base, base + 32)).toBase58();
  const obUsdcVault = new PublicKey(accountData.subarray(base + 32, base + 64)).toBase58();
  const obYesVault = new PublicKey(accountData.subarray(base + 64, base + 96)).toBase58();
  const nextOrderId = Number(accountData.readBigUInt64LE(base + 96));
  const bidCount = accountData.readUInt16LE(base + 104);
  const askCount = accountData.readUInt16LE(base + 106);
  const bump = accountData[base + 108];
  const bidsOffset = base + HEADER_SIZE;
  const asksOffset = bidsOffset + MAX_ORDERS_PER_SIDE * ORDER_SIZE;

  const bids: ParsedOrder[] = [];
  for (let i = 0; i < MAX_ORDERS_PER_SIDE; i++) {
    const order = parseOrder(accountData, bidsOffset + i * ORDER_SIZE);
    if (order.isActive) bids.push(order);
  }
  bids.sort((a, b) => b.price - a.price);

  const asks: ParsedOrder[] = [];
  for (let i = 0; i < MAX_ORDERS_PER_SIDE; i++) {
    const order = parseOrder(accountData, asksOffset + i * ORDER_SIZE);
    if (order.isActive) asks.push(order);
  }
  asks.sort((a, b) => a.price - b.price);

  return { market, obUsdcVault, obYesVault, nextOrderId, bidCount, askCount, bump, bids, asks };
}

async function fetchPythPrices() {
  const results = await Promise.allSettled(
    MAG7.map(async ({ ticker }) => ({ ticker, ...(await fetchPrice(ticker, DEFAULT_FEED_IDS)) }))
  );
  const prices = new Map<Ticker, { price: number; confidence: number; publishTime: number }>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    prices.set(result.value.ticker as Ticker, {
      price: result.value.price,
      confidence: result.value.confidence,
      publishTime: result.value.publishTime,
    });
  }
  return prices;
}

async function buildMarketUniverse(): Promise<MarketUniverse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawMarkets = await queued(() => (program.account as any).strikeMarket.all()) as any[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalized = rawMarkets.map((item: any) => ({
    address: item.publicKey.toBase58(),
    publicKey: item.publicKey.toBase58(),
    ticker: item.account.ticker as Ticker,
    company: MAG7.find((entry) => entry.ticker === item.account.ticker)?.name ?? item.account.ticker,
    yesMint: (item.account.yesMint as PublicKey).toBase58(),
    noMint: (item.account.noMint as PublicKey).toBase58(),
    vault: (item.account.vault as PublicKey).toBase58(),
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
  const activeSet = normalized.filter((item: { ticker: Ticker; date: number }) => latestDates.get(item.ticker) === item.date);
  const orderBookAddresses = activeSet.map((item: { publicKey: string }) =>
    PublicKey.findProgramAddressSync([Buffer.from("orderbook"), new PublicKey(item.publicKey).toBuffer()], PROGRAM_ID)[0]
  );
  const orderBookAccounts = orderBookAddresses.length
    ? await queued(() => connection.getMultipleAccountsInfo(orderBookAddresses, COMMITMENT))
    : [];
  const prices = await fetchPythPrices();
  const marketsByTicker = Object.fromEntries(
    MAG7.map((entry) => [entry.ticker, [] as MarketRecord[]])
  ) as Record<Ticker, MarketRecord[]>;

  activeSet.forEach((item: Omit<MarketRecord, "bestBid" | "bestAsk" | "bestNoBid" | "bestNoAsk" | "yesMid" | "totalDepth" | "orderBook">, index: number) => {
    const bookAccount = orderBookAccounts[index];
    const orderBook = bookAccount ? parseOrderBook(bookAccount.data) : null;
    const bestBid = orderBook?.bids[0]?.price ?? null;
    const bestAsk = orderBook?.asks[0]?.price ?? null;
    const yesMid = bestBid != null && bestAsk != null ? Math.round((bestBid + bestAsk) / 2) : null;
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
    const price = prices.get(entry.ticker);
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

  return {
    asOf: Date.now(),
    tickerSnapshots,
    marketsByTicker,
  };
}

function valueToNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object" && "toNumber" in value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  return null;
}

function getInstructionLabel(name: string): string {
  switch (name) {
    case "mintPair": return "Mint pair";
    case "buyYes": return "Buy Yes";
    case "sellYes": return "Sell Yes";
    case "redeem": return "Redeem";
    case "placeOrder": return "Place order";
    case "cancelOrder": return "Cancel order";
    case "freezeMarket": return "Freeze market";
    case "settleMarket": return "Oracle settle";
    case "adminSettle": return "Admin settle";
    case "createStrikeMarket": return "Create market";
    default: return name;
  }
}

function getActivityKind(name: string): ActivityKind {
  switch (name) {
    case "mintPair":
    case "buyYes":
    case "sellYes":
    case "redeem":
    case "placeOrder":
    case "cancelOrder":
    case "freezeMarket":
    case "settleMarket":
    case "adminSettle":
      return name;
    case "createStrikeMarket":
      return "createMarket";
    default:
      return "unknown";
  }
}

function isPartiallyDecodedInstruction(
  instruction: ParsedInstruction | PartiallyDecodedInstruction
): instruction is PartiallyDecodedInstruction {
  return "data" in instruction;
}

function buildAccountMap(
  instructionName: string,
  instruction: PartiallyDecodedInstruction
): Record<string, string> {
  const accountDefs = idl.instructions.find((item) => item.name === instructionName)?.accounts ?? [];
  const mapped: Record<string, string> = {};
  accountDefs.forEach((account, index) => {
    const pubkey = instruction.accounts[index];
    if (pubkey) mapped[account.name] = pubkey.toBase58();
  });
  return mapped;
}

function decodeInstructionData(instruction: PartiallyDecodedInstruction): DecodedInstruction | null {
  try {
    const decoded = coder.decode(Buffer.from(bs58.decode(instruction.data)));
    if (!decoded) return null;
    return { name: decoded.name, data: (decoded.data ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function inferSide(
  name: string,
  accountMap: Record<string, string>,
  data: Record<string, unknown>,
  market: MarketLookupEntry | null
): "yes" | "no" | null {
  if (name === "buyYes" || name === "sellYes") return "yes";
  if (name === "mintPair") return null;
  const sideRaw = typeof data.side === "string"
    ? data.side
    : data.side && typeof data.side === "object"
      ? Object.keys(data.side as Record<string, unknown>)[0]
      : null;
  if (sideRaw) {
    const normalized = sideRaw.toLowerCase();
    if (normalized.includes("ask")) return "yes";
    if (normalized.includes("bid")) return "no";
  }
  const tokenMint = accountMap.tokenMint;
  if (tokenMint && market) {
    if (tokenMint === market.yesMint) return "yes";
    if (tokenMint === market.noMint) return "no";
  }
  return null;
}

function normalizeInstruction(
  tx: ParsedTransactionWithMeta,
  instruction: PartiallyDecodedInstruction,
  marketLookup: Map<string, MarketLookupEntry>
): ActivityRecord | null {
  const decoded = decodeInstructionData(instruction);
  if (!decoded) return null;
  const accountMap = buildAccountMap(decoded.name, instruction);
  const marketAddress = accountMap.market ?? null;
  const market = marketAddress ? marketLookup.get(marketAddress) ?? null : null;

  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    success: !tx.meta?.err,
    instructionName: decoded.name,
    kind: getActivityKind(decoded.name),
    label: getInstructionLabel(decoded.name),
    marketAddress,
    ticker: market?.ticker ?? null,
    strikePrice: market?.strikePrice ?? null,
    user: accountMap.user ?? accountMap.authority ?? null,
    side: inferSide(decoded.name, accountMap, decoded.data, market),
    amount: valueToNumber(decoded.data.amount),
    price: valueToNumber(decoded.data.price),
    minPrice: valueToNumber(decoded.data.minPrice),
    maxPrice: valueToNumber(decoded.data.maxPrice),
  };
}

async function fetchRelevantSignatures(addresses: PublicKey[], limitPerAddress: number): Promise<string[]> {
  const signatures = new Set<string>();
  for (const address of addresses) {
    const items = await queued(() => connection.getSignaturesForAddress(address, { limit: limitPerAddress }, COMMITMENT));
    for (const item of items) signatures.add(item.signature);
  }
  return [...signatures];
}

async function buildActivity(limit: number): Promise<ActivityRecord[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawMarkets = await queued(() => (program.account as any).strikeMarket.all());
  const latestDates = new Map<Ticker, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const item of rawMarkets as any[]) {
    const ticker = item.account.ticker as Ticker;
    const date = item.account.date.toNumber() as number;
    const current = latestDates.get(ticker);
    if (current == null || date > current) latestDates.set(ticker, date);
  }

  const marketLookup = new Map<string, MarketLookupEntry>();
  const marketAddresses: PublicKey[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const item of rawMarkets as any[]) {
    const ticker = item.account.ticker as Ticker;
    const date = item.account.date.toNumber() as number;
    if (latestDates.get(ticker) !== date) continue;

    const address = (item.publicKey as PublicKey).toBase58();
    marketLookup.set(address, {
      address,
      ticker,
      strikePrice: item.account.strikePrice.toNumber() as number,
      yesMint: (item.account.yesMint as PublicKey).toBase58(),
      noMint: (item.account.noMint as PublicKey).toBase58(),
    });
    marketAddresses.push(item.publicKey as PublicKey);
  }

  const signatures = await fetchRelevantSignatures(marketAddresses, ACTIVITY_SIGNATURES_PER_MARKET);
  if (signatures.length === 0) return [];

  const transactions = await queued(() => connection.getParsedTransactions(signatures.slice(0, limit), {
    commitment: COMMITMENT,
    maxSupportedTransactionVersion: 0,
  }));

  const activity: ActivityRecord[] = [];
  for (const tx of transactions) {
    if (!tx) continue;
    for (const instruction of tx.transaction.message.instructions) {
      if (!isPartiallyDecodedInstruction(instruction)) continue;
      if (!instruction.programId.equals(PROGRAM_ID)) continue;
      const normalized = normalizeInstruction(tx, instruction, marketLookup);
      if (!normalized) continue;
      if (!normalized.marketAddress || !marketLookup.has(normalized.marketAddress)) continue;
      activity.push(normalized);
    }
  }

  activity.sort((a, b) => {
    if ((b.blockTime ?? 0) !== (a.blockTime ?? 0)) return (b.blockTime ?? 0) - (a.blockTime ?? 0);
    return b.slot - a.slot;
  });

  return activity.slice(0, limit);
}

type CachedState<T> = {
  value: T | null;
  at: number;
  inflight: Promise<T> | null;
};

const marketState: CachedState<MarketUniverse> = { value: null, at: 0, inflight: null };
const activityState = new Map<number, CachedState<ActivityRecord[]>>();

async function cached<T>(state: CachedState<T>, ttlMs: number, builder: () => Promise<T>): Promise<T> {
  if (state.value && Date.now() - state.at < ttlMs) return state.value;
  if (state.inflight) return state.inflight;
  state.inflight = builder()
    .then((next) => {
      state.value = next;
      state.at = Date.now();
      return next;
    })
    .finally(() => {
      state.inflight = null;
    });
  return state.inflight;
}

async function handle(url: URL) {
  if (url.pathname === "/health") {
    return json({ ok: true, asOf: Date.now(), rpcUrl: RPC_URL });
  }

  if (url.pathname === "/markets") {
    const payload = await cached(marketState, MARKET_TTL_MS, buildMarketUniverse);
    return json(payload);
  }

  if (url.pathname === "/activity") {
    const limit = Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Number(url.searchParams.get("limit") || "12")));
    const state = activityState.get(limit) ?? { value: null, at: 0, inflight: null };
    activityState.set(limit, state);
    const payload = await cached(state, ACTIVITY_TTL_MS, () => buildActivity(limit));
    return json(payload);
  }

  return json({ error: "Not found" }, 404);
}

createServer(async (req, res) => {
  if (!req.url) {
    const out = json({ error: "Missing URL" }, 400);
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
    return;
  }

  if (req.method === "OPTIONS") {
    const out = json({ ok: true });
    res.writeHead(204, out.headers);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    const out = json({ error: "Method not allowed" }, 405);
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
    return;
  }

  try {
    const out = await handle(new URL(req.url, `http://${req.headers.host || "localhost"}`));
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[read-api] request failed:", error);
    const out = json({ error: message }, 500);
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[read-api] listening on 0.0.0.0:${PORT}`);
  console.log(`[read-api] RPC: ${RPC_URL}`);
  console.log(`[read-api] global RPC queue gap: ${RPC_GAP_MS}ms`);
});
