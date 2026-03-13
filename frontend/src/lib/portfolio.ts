import { BorshInstructionCoder, type Idl, type Program } from "@coral-xyz/anchor";
import type { MarketRecord } from "./market-data";
import BN from "bn.js";
import { PublicKey, Transaction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { PORTFOLIO_SIGNATURE_LIMIT, PROGRAM_ID, USDC_PER_PAIR } from "./constants";
import idl from "../idl/meridian.json";

const instructionCoder = new BorshInstructionCoder(idl as Idl);

export interface Position {
  market: PublicKey;
  ticker: string;
  strikePrice: number;
  date: number;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  bump: number;
  yesBalance: number;
  noBalance: number;
  settled: boolean;
  outcome: "pending" | "yesWins" | "noWins";
  settlementPrice?: number;
}

export interface PositionPerformance {
  yesEntryPrice: number | null;
  noEntryPrice: number | null;
  pairEntryPrice: number | null;
  costBasis: number | null;
  currentValue: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number;
  pairedContracts: number;
  partialHistory: boolean;
}

interface PositionPerformanceState {
  yesQty: number;
  yesCost: number;
  noQty: number;
  noCost: number;
  pairQty: number;
  pairCost: number;
  realizedPnl: number;
}

interface TokenDelta {
  yes: number;
  no: number;
  usdc: number;
}

function emptyPerformanceState(): PositionPerformanceState {
  return {
    yesQty: 0,
    yesCost: 0,
    noQty: 0,
    noCost: 0,
    pairQty: 0,
    pairCost: 0,
    realizedPnl: 0,
  };
}

function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Math.abs(rounded) < 1e-9 ? 0 : rounded;
}

function consumeStandalone(
  qty: number,
  heldQty: number,
  heldCost: number
): { remainingQty: number; remainingCost: number; consumedQty: number; consumedCost: number } {
  if (qty <= 0 || heldQty <= 0) {
    return {
      remainingQty: heldQty,
      remainingCost: heldCost,
      consumedQty: 0,
      consumedCost: 0,
    };
  }

  const consumedQty = Math.min(qty, heldQty);
  const avgCost = heldQty > 0 ? heldCost / heldQty : 0;
  const consumedCost = avgCost * consumedQty;

  return {
    remainingQty: heldQty - consumedQty,
    remainingCost: Math.max(0, heldCost - consumedCost),
    consumedQty,
    consumedCost,
  };
}

function normalizeInstructionName(name: string): string {
  return name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

function getInstructionNames(tx: ParsedTransactionWithMeta): string[] {
  const names = new Set<string>();

  for (const instruction of tx.transaction.message.instructions) {
    if (!("data" in instruction)) continue;
    const decodedInstruction = instruction as PartiallyDecodedInstruction;
    if (!decodedInstruction.programId.equals(PROGRAM_ID)) continue;
    try {
      const decoded = instructionCoder.decode(Buffer.from(bs58.decode(decodedInstruction.data)));
      if (decoded?.name) names.add(normalizeInstructionName(decoded.name));
    } catch {
      // Ignore undecodable instructions in the same transaction.
    }
  }

  return [...names];
}

function getInstructionMarketAddresses(
  tx: ParsedTransactionWithMeta,
  trackedMarkets: Map<string, Position>
): Set<string> {
  const addresses = new Set<string>();

  for (const instruction of tx.transaction.message.instructions) {
    if (!("data" in instruction)) continue;
    const decodedInstruction = instruction as PartiallyDecodedInstruction;
    if (!decodedInstruction.programId.equals(PROGRAM_ID)) continue;

    try {
      const decoded = instructionCoder.decode(Buffer.from(bs58.decode(decodedInstruction.data)));
      if (!decoded?.name) continue;
      const accountDefs = (idl as Idl).instructions.find((item) => item.name === decoded.name)?.accounts ?? [];
      const marketIndex = accountDefs.findIndex((account) => account.name === "market");
      if (marketIndex < 0) continue;
      const marketAddress = decodedInstruction.accounts[marketIndex]?.toBase58();
      if (marketAddress && trackedMarkets.has(marketAddress)) addresses.add(marketAddress);
    } catch {
      // Ignore undecodable instructions in the same transaction.
    }
  }

  return addresses;
}

function buildMintDeltaMap(tx: ParsedTransactionWithMeta, wallet: PublicKey): Map<string, number> {
  const walletBase58 = wallet.toBase58();
  const deltas = new Map<string, number>();

  const applyBalance = (
    balances: NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"] | NonNullable<ParsedTransactionWithMeta["meta"]>["postTokenBalances"],
    direction: -1 | 1
  ) => {
    for (const balance of balances ?? []) {
      if (balance.owner !== walletBase58) continue;
      const amount = Number(balance.uiTokenAmount.amount);
      if (!Number.isFinite(amount)) continue;
      deltas.set(balance.mint, (deltas.get(balance.mint) ?? 0) + amount * direction);
    }
  };

  applyBalance(tx.meta?.preTokenBalances ?? [], -1);
  applyBalance(tx.meta?.postTokenBalances ?? [], 1);

  return deltas;
}

function classifyFlow(names: string[]): "buyNo" | "sellNo" | "mintPair" | "buyYes" | "sellYes" | "redeem" | null {
  const set = new Set(names);
  if (set.has("mintPair") && set.has("sellYes")) return "buyNo";
  if (set.has("buyYes") && set.has("redeem")) return "sellNo";
  if (set.has("mintPair")) return "mintPair";
  if (set.has("buyYes")) return "buyYes";
  if (set.has("sellYes")) return "sellYes";
  if (set.has("redeem")) return "redeem";
  return null;
}

function currentPairValue(position: Position, yesPrice: number | null, noPrice: number | null): number | null {
  if (position.outcome === "yesWins" || position.outcome === "noWins") return 1;
  if (yesPrice == null || noPrice == null) return null;
  return (yesPrice + noPrice) / USDC_PER_PAIR;
}

function finalizePerformance(
  state: PositionPerformanceState,
  position: Position,
  yesPrice: number | null,
  noPrice: number | null
): PositionPerformance {
  const pairedContracts = Math.min(position.yesBalance, position.noBalance, Math.round(state.pairQty));
  const standaloneYes = Math.max(0, position.yesBalance - pairedContracts);
  const standaloneNo = Math.max(0, position.noBalance - pairedContracts);
  const partialHistory =
    state.yesQty + 1e-9 < standaloneYes ||
    state.noQty + 1e-9 < standaloneNo ||
    state.pairQty + 1e-9 < pairedContracts;

  const pairValue = currentPairValue(position, yesPrice, noPrice);
  const currentValue =
    yesPrice == null || noPrice == null || pairValue == null
      ? null
      : roundUsd(
        standaloneYes * (yesPrice / USDC_PER_PAIR) +
        standaloneNo * (noPrice / USDC_PER_PAIR) +
        pairedContracts * pairValue
      );

  const costBasis = roundUsd(state.yesCost + state.noCost + state.pairCost);

  return {
    yesEntryPrice: !partialHistory && standaloneYes > 0 && state.yesQty > 0 ? Math.round((state.yesCost / state.yesQty) * USDC_PER_PAIR) : null,
    noEntryPrice: !partialHistory && standaloneNo > 0 && state.noQty > 0 ? Math.round((state.noCost / state.noQty) * USDC_PER_PAIR) : null,
    pairEntryPrice: !partialHistory && pairedContracts > 0 && state.pairQty > 0 ? Math.round((state.pairCost / state.pairQty) * USDC_PER_PAIR) : null,
    costBasis: !partialHistory && costBasis > 0 ? costBasis : null,
    currentValue,
    unrealizedPnl: !partialHistory && currentValue != null && costBasis > 0 ? roundUsd(currentValue - costBasis) : null,
    realizedPnl: roundUsd(state.realizedPnl),
    pairedContracts,
    partialHistory,
  };
}

export async function fetchPositionPerformance(
  connection: Connection,
  wallet: PublicKey,
  positions: Position[],
  usdcMint: PublicKey
): Promise<Map<string, PositionPerformance>> {
  const signatures = await connection.getSignaturesForAddress(
    wallet,
    { limit: PORTFOLIO_SIGNATURE_LIMIT },
    "confirmed"
  );
  if (signatures.length === 0) {
    return new Map(
      positions.map((position) => [
        position.market.toBase58(),
        finalizePerformance(emptyPerformanceState(), position, null, null),
      ])
    );
  }

  const transactions = await connection.getParsedTransactions(
    signatures.map((item) => item.signature),
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
  );

  const chronologicallySorted = transactions
    .filter((tx): tx is ParsedTransactionWithMeta => !!tx)
    .sort((a, b) => {
      if ((a.blockTime ?? 0) !== (b.blockTime ?? 0)) return (a.blockTime ?? 0) - (b.blockTime ?? 0);
      return a.slot - b.slot;
    });

  return derivePositionPerformanceFromTransactions(chronologicallySorted, wallet, positions, usdcMint);
}

export function derivePositionPerformanceFromTransactions(
  transactions: ParsedTransactionWithMeta[],
  wallet: PublicKey,
  positions: Position[],
  usdcMint: PublicKey
): Map<string, PositionPerformance> {
  const states = new Map<string, PositionPerformanceState>();
  const trackedMarkets = new Map(
    positions.map((position) => [
      position.market.toBase58(),
      position,
    ])
  );

  for (const tx of transactions) {
    const names = getInstructionNames(tx);
    const flow = classifyFlow(names);
    if (!flow) continue;

    const marketAddresses = getInstructionMarketAddresses(tx, trackedMarkets);
    if (marketAddresses.size === 0) continue;

    const mintDeltas = buildMintDeltaMap(tx, wallet);

    for (const marketAddress of marketAddresses) {
      const position = trackedMarkets.get(marketAddress);
      if (!position) continue;

      const state = states.get(marketAddress) ?? emptyPerformanceState();
      states.set(marketAddress, state);

      const delta: TokenDelta = {
        yes: mintDeltas.get(position.yesMint.toBase58()) ?? 0,
        no: mintDeltas.get(position.noMint.toBase58()) ?? 0,
        usdc: mintDeltas.get(usdcMint.toBase58()) ?? 0,
      };

      switch (flow) {
        case "buyYes":
          if (delta.yes > 0 && delta.usdc < 0) {
            state.yesQty += delta.yes;
            state.yesCost += -delta.usdc / USDC_PER_PAIR;
          }
          break;
        case "sellYes":
          if (delta.yes < 0 && delta.usdc > 0) {
            const soldQty = -delta.yes;
            const consumed = consumeStandalone(soldQty, state.yesQty, state.yesCost);
            state.yesQty = consumed.remainingQty;
            state.yesCost = consumed.remainingCost;
            state.realizedPnl = roundUsd(state.realizedPnl + delta.usdc / USDC_PER_PAIR - consumed.consumedCost);
          }
          break;
        case "buyNo":
          if (delta.no > 0 && delta.usdc < 0) {
            state.noQty += delta.no;
            state.noCost += -delta.usdc / USDC_PER_PAIR;
          }
          break;
        case "sellNo":
          if (delta.no < 0 && delta.usdc > 0) {
            const soldQty = -delta.no;
            const consumed = consumeStandalone(soldQty, state.noQty, state.noCost);
            state.noQty = consumed.remainingQty;
            state.noCost = consumed.remainingCost;
            state.realizedPnl = roundUsd(state.realizedPnl + delta.usdc / USDC_PER_PAIR - consumed.consumedCost);
          }
          break;
        case "mintPair":
          if (delta.yes > 0 && delta.no > 0 && delta.usdc < 0) {
            const pairs = Math.min(delta.yes, delta.no);
            state.pairQty += pairs;
            state.pairCost += -delta.usdc / USDC_PER_PAIR;
          }
          break;
        case "redeem":
          if (delta.yes < 0 && delta.no < 0 && delta.usdc > 0) {
            const redeemedPairs = Math.min(-delta.yes, -delta.no);
            const avgPairCost = state.pairQty > 0 ? state.pairCost / state.pairQty : 0;
            const redeemedCost = avgPairCost * redeemedPairs;
            state.pairQty = Math.max(0, state.pairQty - redeemedPairs);
            state.pairCost = Math.max(0, state.pairCost - redeemedCost);
            state.realizedPnl = roundUsd(state.realizedPnl + delta.usdc / USDC_PER_PAIR - redeemedCost);
          } else if (delta.yes < 0 && delta.usdc >= 0) {
            const redeemedQty = -delta.yes;
            const consumed = consumeStandalone(redeemedQty, state.yesQty, state.yesCost);
            state.yesQty = consumed.remainingQty;
            state.yesCost = consumed.remainingCost;
            state.realizedPnl = roundUsd(state.realizedPnl + delta.usdc / USDC_PER_PAIR - consumed.consumedCost);
          } else if (delta.no < 0 && delta.usdc >= 0) {
            const redeemedQty = -delta.no;
            const consumed = consumeStandalone(redeemedQty, state.noQty, state.noCost);
            state.noQty = consumed.remainingQty;
            state.noCost = consumed.remainingCost;
            state.realizedPnl = roundUsd(state.realizedPnl + delta.usdc / USDC_PER_PAIR - consumed.consumedCost);
          }
          break;
      }
    }
  }

  return new Map(
    positions.map((position) => [
      position.market.toBase58(),
      finalizePerformance(states.get(position.market.toBase58()) ?? emptyPerformanceState(), position, null, null),
    ])
  );
}

// Fetch all positions for a wallet across all markets
export async function fetchPositions(
  program: Program,
  connection: Connection,
  wallet: PublicKey,
  existingMarkets?: MarketRecord[]
): Promise<Position[]> {
  const allMarkets = existingMarkets
    ? existingMarkets.map((m) => ({
        publicKey: m.publicKey,
        account: {
          yesMint: m.yesMint,
          noMint: m.noMint,
          strikePrice: { toNumber: () => m.strikePrice },
          date: { toNumber: () => m.date },
          ticker: m.ticker,
          vault: m.vault,
          bump: 0,
          outcome: m.outcome === "yesWins" ? { yesWins: {} } : m.outcome === "noWins" ? { noWins: {} } : { pending: {} },
          settlementPrice: m.settlementPrice != null ? { toNumber: () => m.settlementPrice } : null,
        },
      }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : await (program.account as any).strikeMarket.all();
  const positions: Position[] = [];

  // Batch fetch all token accounts for this wallet
  const tokenAccounts = await connection.getTokenAccountsByOwner(wallet, {
    programId: TOKEN_PROGRAM_ID,
  });

  // Build a mint -> balance map
  const balanceMap = new Map<string, number>();
  for (const { account } of tokenAccounts.value) {
    const data = account.data;
    // SPL Token layout: mint (32 bytes), owner (32 bytes), amount (8 bytes LE)
    const mint = new PublicKey(data.subarray(0, 32));
    const amount = Number(data.readBigUInt64LE(64));
    if (amount > 0) {
      balanceMap.set(mint.toString(), amount);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of allMarkets as any[]) {
    const yesMint = m.account.yesMint as PublicKey;
    const noMint = m.account.noMint as PublicKey;
    const yesBalance = balanceMap.get(yesMint.toString()) ?? 0;
    const noBalance = balanceMap.get(noMint.toString()) ?? 0;

    if (yesBalance === 0 && noBalance === 0) continue;

    const outcome = m.account.outcome;
    let outcomeStr: "pending" | "yesWins" | "noWins" = "pending";
    if (outcome?.yesWins !== undefined) outcomeStr = "yesWins";
    else if (outcome?.noWins !== undefined) outcomeStr = "noWins";

    positions.push({
      market: m.publicKey,
      ticker: m.account.ticker as string,
      strikePrice: m.account.strikePrice.toNumber(),
      date: m.account.date.toNumber(),
      yesMint,
      noMint,
      vault: m.account.vault as PublicKey,
      bump: m.account.bump as number,
      yesBalance,
      noBalance,
      settled: outcomeStr !== "pending",
      outcome: outcomeStr,
      settlementPrice: m.account.settlementPrice?.toNumber?.() ?? undefined,
    });
  }

  return positions.sort((a, b) => {
    if (a.settled !== b.settled) return a.settled ? 1 : -1;
    if (a.ticker !== b.ticker) return a.ticker.localeCompare(b.ticker);
    return a.strikePrice - b.strikePrice;
  });
}

// Build redeem TX for winning tokens
export async function buildRedeemTx(
  program: Program,
  user: PublicKey,
  market: PublicKey,
  tokenMint: PublicKey, // yes_mint or no_mint
  usdcMint: PublicKey,
  amount: number
): Promise<Transaction> {
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
  const userToken = getAssociatedTokenAddressSync(tokenMint, user);

  const tx = new Transaction();

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdc,
      user,
      usdcMint
    )
  );

  const ix = await program.methods
    .redeem(new BN(amount))
    .accountsPartial({
      user,
      market,
      userUsdc,
      tokenMint,
      userToken,
    })
    .instruction();

  tx.add(ix);
  return tx;
}

// Build a pre-settlement complete-set exit through the canonical redeem
// instruction.
export async function buildBurnPairTx(
  program: Program,
  user: PublicKey,
  market: PublicKey,
  yesMint: PublicKey,
  noMint: PublicKey,
  usdcMint: PublicKey,
  amount: number
): Promise<Transaction> {
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
  const userYes = getAssociatedTokenAddressSync(yesMint, user);
  const userNo = getAssociatedTokenAddressSync(noMint, user);

  const tx = new Transaction();

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdc,
      user,
      usdcMint
    )
  );

  const ix = await program.methods
    .redeem(new BN(amount))
    .accountsPartial({
      user,
      market,
      userUsdc,
      tokenMint: yesMint,
      userToken: userYes,
    })
    .remainingAccounts([
      { pubkey: noMint, isWritable: true, isSigner: false },
      { pubkey: userNo, isWritable: true, isSigner: false },
    ])
    .instruction();

  tx.add(ix);
  return tx;
}

// Check if user holds conflicting tokens for a market
export function getPositionConflict(
  balanceMap: Map<string, number>,
  yesMint: PublicKey,
  noMint: PublicKey,
  action: "buyYes" | "buyNo" | "sellYes" | "sellNo"
): string | null {
  const yesBalance = balanceMap.get(yesMint.toString()) ?? 0;
  const noBalance = balanceMap.get(noMint.toString()) ?? 0;

  if (action === "buyYes" && noBalance > 0) {
    return `You hold ${noBalance} No token${noBalance > 1 ? "s" : ""}. Sell your No position first.`;
  }
  if (action === "buyNo" && yesBalance > 0) {
    return `You hold ${yesBalance} Yes token${yesBalance > 1 ? "s" : ""}. Sell your Yes position first.`;
  }
  return null;
}

export function formatUsdcPrice(baseUnits: number): string {
  return `$${(baseUnits / USDC_PER_PAIR).toFixed(2)}`;
}
