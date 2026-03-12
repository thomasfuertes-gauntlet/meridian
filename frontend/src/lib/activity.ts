import { useEffect, useState } from "react";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import {
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import idl from "../idl/meridian.json";
import { connection, getReadOnlyProgram } from "./anchor";
import {
  ACTIVITY_LIMIT,
  ACTIVITY_POLL_MS,
  ACTIVITY_SIGNATURES_PER_MARKET,
  IS_REMOTE_RPC,
  MAG7,
  PROGRAM_ID,
  READ_API_URL,
  USDC_PER_PAIR,
  type Ticker,
} from "./constants";

export type ActivityKind =
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

export interface ActivityRecord {
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
  date: number;
  strikePrice: number;
  yesMint: string;
  noMint: string;
}

interface DecodedInstruction {
  name: string;
  data: Record<string, unknown>;
}

function valueToNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber() as number;
  }
  return null;
}

function getInstructionLabel(name: string): string {
  switch (name) {
    case "mintPair":
      return "Mint pair";
    case "buyYes":
      return "Buy Yes";
    case "sellYes":
      return "Sell Yes";
    case "redeem":
      return "Redeem";
    case "placeOrder":
      return "Place order";
    case "cancelOrder":
      return "Cancel order";
    case "freezeMarket":
      return "Freeze market";
    case "settleMarket":
      return "Oracle settle";
    case "adminSettle":
      return "Admin settle";
    case "createStrikeMarket":
      return "Create market";
    default:
      return name;
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

function isPartiallyDecodedInstruction(
  instruction: ParsedInstruction | PartiallyDecodedInstruction
): instruction is PartiallyDecodedInstruction {
  return "data" in instruction;
}

function buildAccountMap(
  instructionName: string,
  instruction: PartiallyDecodedInstruction
): Record<string, string> {
  const accountDefs =
    (idl as Idl).instructions.find((item) => item.name === instructionName)?.accounts ?? [];
  const mapped: Record<string, string> = {};
  accountDefs.forEach((account, index) => {
    const pubkey = instruction.accounts[index];
    if (pubkey) {
      mapped[account.name] = pubkey.toBase58();
    }
  });
  return mapped;
}

function decodeInstructionData(
  coder: BorshInstructionCoder,
  instruction: PartiallyDecodedInstruction
): DecodedInstruction | null {
  try {
    const decoded = coder.decode(Buffer.from(bs58.decode(instruction.data)));
    if (!decoded) return null;
    return {
      name: decoded.name,
      data: (decoded.data ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function normalizeInstruction(
  tx: ParsedTransactionWithMeta,
  instruction: PartiallyDecodedInstruction,
  marketLookup: Map<string, MarketLookupEntry>,
  coder: BorshInstructionCoder
): ActivityRecord | null {
  const decoded = decodeInstructionData(coder, instruction);
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

async function fetchRelevantSignatures(
  addresses: PublicKey[],
  limitPerAddress: number
): Promise<string[]> {
  const signatureGroups = await Promise.all(
    addresses.map((address) =>
      connection.getSignaturesForAddress(address, { limit: limitPerAddress }, "confirmed")
    )
  );
  return [...new Set(signatureGroups.flat().map((item) => item.signature))];
}

const activityCache = new Map<number, { records: ActivityRecord[]; at: number }>();
const activityInflight = new Map<number, Promise<ActivityRecord[]>>();

export async function fetchActivityFeed(limit = ACTIVITY_LIMIT): Promise<ActivityRecord[]> {
  const cached = activityCache.get(limit);
  if (cached && Date.now() - cached.at < Math.max(10_000, ACTIVITY_POLL_MS / 2)) {
    return cached.records;
  }
  const inflight = activityInflight.get(limit);
  if (inflight) return inflight;

  const request = (async () => {
  if (IS_REMOTE_RPC && READ_API_URL) {
    try {
      const response = await fetch(`${READ_API_URL}/activity?limit=${limit}`);
      if (!response.ok) {
        throw new Error(`Read API returned ${response.status} for /activity`);
      }
      const next = await response.json() as ActivityRecord[];
      activityCache.set(limit, { records: next, at: Date.now() });
      return next;
    } catch (error) {
      console.warn("Read API /activity failed, falling back to direct RPC:", error);
    }
  }

  const program = getReadOnlyProgram();
  const coder = new BorshInstructionCoder(idl as Idl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawMarkets = await (program.account as any).strikeMarket.all();

  const latestDates = new Map<Ticker, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const item of rawMarkets as any[]) {
    const ticker = item.account.ticker as Ticker;
    const date = item.account.date.toNumber() as number;
    const current = latestDates.get(ticker);
    if (current == null || date > current) {
      latestDates.set(ticker, date);
    }
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
      date,
      strikePrice: item.account.strikePrice.toNumber() as number,
      yesMint: (item.account.yesMint as PublicKey).toBase58(),
      noMint: (item.account.noMint as PublicKey).toBase58(),
    });
    marketAddresses.push(item.publicKey as PublicKey);
  }

  const signatures = await fetchRelevantSignatures(marketAddresses, ACTIVITY_SIGNATURES_PER_MARKET);
  if (signatures.length === 0) return [];

  const transactions = await connection.getParsedTransactions(signatures.slice(0, limit), {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  const activity: ActivityRecord[] = [];
  for (const tx of transactions) {
    if (!tx) continue;

    for (const instruction of tx.transaction.message.instructions) {
      if (!isPartiallyDecodedInstruction(instruction)) continue;
      if (!instruction.programId.equals(PROGRAM_ID)) continue;
      const normalized = normalizeInstruction(tx, instruction, marketLookup, coder);
      if (!normalized) continue;
      if (!normalized.marketAddress || !marketLookup.has(normalized.marketAddress)) continue;
      activity.push(normalized);
    }
  }

  activity.sort((a, b) => {
    if ((b.blockTime ?? 0) !== (a.blockTime ?? 0)) {
      return (b.blockTime ?? 0) - (a.blockTime ?? 0);
    }
    return b.slot - a.slot;
  });

    const next = activity.slice(0, limit);
    activityCache.set(limit, { records: next, at: Date.now() });
    return next;
  })();

  activityInflight.set(limit, request);
  try {
    return await request;
  } finally {
    activityInflight.delete(limit);
  }
}

export function useActivityFeed(limit = ACTIVITY_LIMIT) {
  const [data, setData] = useState<ActivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (document.visibilityState === "hidden") return;
      setLoading(true);
      try {
        const next = await fetchActivityFeed(limit);
        if (!alive) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Failed to load activity");
      } finally {
        if (alive) setLoading(false);
      }
    }

    void load();
    const interval = window.setInterval(() => void load(), ACTIVITY_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [limit]);

  return { data, loading, error };
}

export function formatActivityPrice(record: ActivityRecord): number | null {
  if (record.price != null) return record.price;
  if (record.maxPrice != null) return record.maxPrice;
  if (record.minPrice != null) return record.minPrice;
  return null;
}

export function formatActivityNotional(record: ActivityRecord): number | null {
  const price = formatActivityPrice(record);
  if (price == null || record.amount == null) return null;
  return (price / USDC_PER_PAIR) * record.amount;
}

export function getActivityTickers(): Ticker[] {
  return MAG7.map((entry) => entry.ticker);
}
