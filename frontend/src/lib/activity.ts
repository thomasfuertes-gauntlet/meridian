import { useContext, useEffect, useRef, useState } from "react";
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
  MAG7,
  PROGRAM_ID,
  USDC_PER_PAIR,
  type Ticker,
} from "./constants";
import { MarketDataContext } from "./market-data-context";
import type { MarketRecord } from "./market-data";

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

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
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
  // IDL stores snake_case instruction names; decoded.name is already camelCase,
  // so convert back for the IDL lookup.
  const snakeName = instructionName.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const accountDefs =
    (idl as Idl).instructions.find((item) => item.name === snakeName)?.accounts ?? [];
  const mapped: Record<string, string> = {};
  accountDefs.forEach((account, index) => {
    const pubkey = instruction.accounts[index];
    if (pubkey) {
      mapped[snakeToCamel(account.name)] = pubkey.toBase58();
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
    // Anchor 0.32 IDL uses snake_case; normalize to camelCase for consumers
    const rawData = (decoded.data ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawData)) data[snakeToCamel(k)] = v;
    return { name: snakeToCamel(decoded.name), data };
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

async function fetchProgramSignatures(rawLimit: number): Promise<string[]> {
  const sigs = await connection.getSignaturesForAddress(
    PROGRAM_ID, { limit: rawLimit }, "confirmed"
  );
  return sigs.map((s) => s.signature);
}

type ActivityFeedResult = { records: ActivityRecord[]; lookup: Map<string, MarketLookupEntry> };

const activityCache = new Map<string, { records: ActivityRecord[]; lookup: Map<string, MarketLookupEntry>; at: number }>();
const activityInflight = new Map<string, Promise<ActivityFeedResult>>();

export async function fetchActivityFeed(
  limit = ACTIVITY_LIMIT,
  filterTicker?: Ticker,
  existingMarkets?: MarketRecord[],
): Promise<ActivityFeedResult> {
  const cacheKey = `${limit}:${filterTicker ?? "all"}`;
  const cached = activityCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30_000) {
    return { records: cached.records, lookup: cached.lookup };
  }
  const inflight = activityInflight.get(cacheKey);
  if (inflight) return inflight;

  const request = (async (): Promise<ActivityFeedResult> => {
  const coder = new BorshInstructionCoder(idl as Idl);

  let marketLookup: Map<string, MarketLookupEntry>;
  if (existingMarkets) {
    // Build lookup from context data - no RPC needed
    const latestDates = new Map<Ticker, number>();
    for (const m of existingMarkets) {
      const current = latestDates.get(m.ticker);
      if (current == null || m.date > current) latestDates.set(m.ticker, m.date);
    }
    marketLookup = new Map();
    for (const m of existingMarkets) {
      if (latestDates.get(m.ticker) !== m.date) continue;
      if (filterTicker && m.ticker !== filterTicker) continue;
      marketLookup.set(m.address, {
        address: m.address,
        ticker: m.ticker,
        date: m.date,
        strikePrice: m.strikePrice,
        yesMint: m.yesMint.toBase58(),
        noMint: m.noMint.toBase58(),
      });
    }
  } else {
    // Fall back to RPC
    const program = getReadOnlyProgram();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawMarkets = await (program.account as any).strikeMarket.all();

    const latestDates = new Map<Ticker, number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of rawMarkets as any[]) {
      const ticker = item.account.ticker as Ticker;
      const date = item.account.date.toNumber() as number;
      const current = latestDates.get(ticker);
      if (current == null || date > current) latestDates.set(ticker, date);
    }
    marketLookup = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of rawMarkets as any[]) {
      const ticker = item.account.ticker as Ticker;
      const date = item.account.date.toNumber() as number;
      if (latestDates.get(ticker) !== date) continue;
      if (filterTicker && ticker !== filterTicker) continue;
      const address = (item.publicKey as PublicKey).toBase58();
      marketLookup.set(address, {
        address,
        ticker,
        date,
        strikePrice: item.account.strikePrice.toNumber() as number,
        yesMint: (item.account.yesMint as PublicKey).toBase58(),
        noMint: (item.account.noMint as PublicKey).toBase58(),
      });
    }
  }

  const signatures = await fetchProgramSignatures(limit * 3);
  if (signatures.length === 0) return { records: [], lookup: marketLookup };

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
    activityCache.set(cacheKey, { records: next, lookup: marketLookup, at: Date.now() });
    return { records: next, lookup: marketLookup };
  })();

  activityInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    activityInflight.delete(cacheKey);
  }
}

export function useActivityFeed(limit = ACTIVITY_LIMIT, filterTicker?: Ticker) {
  const [data, setData] = useState<ActivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bufferRef = useRef<ActivityRecord[]>([]);
  const marketLookupRef = useRef<Map<string, MarketLookupEntry>>(new Map());
  const coderRef = useRef(new BorshInstructionCoder(idl as Idl));
  const ctx = useContext(MarketDataContext);
  const ctxRef = useRef(ctx.data);
  ctxRef.current = ctx.data;

  useEffect(() => {
    let alive = true;
    const RING_SIZE = 120;

    async function init() {
      const contextMarkets = ctxRef.current
        ? Object.values(ctxRef.current.marketsByTicker).flat()
        : undefined;
      const { records, lookup } = await fetchActivityFeed(limit, filterTicker, contextMarkets);
      if (!alive) return;
      marketLookupRef.current = lookup;
      bufferRef.current = records.slice(0, RING_SIZE);
      setData([...bufferRef.current]);
      setError(null);
    }

    init()
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Failed to load activity");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    const subId = connection.onLogs(
      PROGRAM_ID,
      ({ signature, err: txErr, logs }) => {
        if (!alive || txErr) return;
        // Quick bail if no instruction log line
        if (!logs.some((l) => l.includes("Program log: Instruction:"))) return;

        void (async () => {
          try {
            const txs = await connection.getParsedTransactions([signature], {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            const tx = txs[0];
            if (!tx || !alive) return;

            const lookup = marketLookupRef.current;
            const newRecords: ActivityRecord[] = [];
            for (const instruction of tx.transaction.message.instructions) {
              if (!isPartiallyDecodedInstruction(instruction)) continue;
              if (!instruction.programId.equals(PROGRAM_ID)) continue;
              const normalized = normalizeInstruction(tx, instruction, lookup, coderRef.current);
              if (!normalized) continue;
              if (!normalized.marketAddress || !lookup.has(normalized.marketAddress)) continue;
              if (filterTicker && normalized.ticker !== filterTicker) continue;
              newRecords.push(normalized);
            }

            if (newRecords.length === 0 || !alive) return;
            bufferRef.current = [...newRecords, ...bufferRef.current].slice(0, RING_SIZE);
            setData([...bufferRef.current]);
          } catch {
            // ignore tx fetch errors
          }
        })();
      },
      "confirmed"
    );

    return () => {
      alive = false;
      connection.removeOnLogsListener(subId).catch(() => {});
    };
  }, [limit, filterTicker]);

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
