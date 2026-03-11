import test from "node:test";
import assert from "node:assert/strict";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import idl from "../idl/meridian.json";
import { PROGRAM_ID } from "./constants";
import { derivePositionPerformanceFromTransactions, type Position } from "./portfolio";

const coder = new BorshInstructionCoder(idl as Idl);
const wallet = new PublicKey("5Ux797xeoqotK8b6qtjYWwfS2fv7p9ZLV9V2ZAcxiyo");
const market = new PublicKey("11111111111111111111111111111112");
const yesMint = new PublicKey("11111111111111111111111111111113");
const noMint = new PublicKey("11111111111111111111111111111114");
const vault = new PublicKey("11111111111111111111111111111115");
const usdcMint = new PublicKey("11111111111111111111111111111116");

const basePosition: Position = {
  market,
  ticker: "META",
  strikePrice: 680_000_000,
  date: 20260311,
  yesMint,
  noMint,
  vault,
  bump: 255,
  yesBalance: 0,
  noBalance: 0,
  settled: false,
  outcome: "pending",
};

function assertApprox(actual: number, expected: number, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

function instructionAccounts(name: string, marketKey: PublicKey): PublicKey[] {
  const accountDefs = (idl as Idl).instructions.find((item) => item.name === name)?.accounts ?? [];
  return accountDefs.map((account) => (account.name === "market" ? marketKey : wallet));
}

function encodeArgs(data: Record<string, bigint | number | object>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === "number" || typeof value === "bigint" ? new BN(value) : value,
    ])
  );
}

function buildInstruction(name: string, data: Record<string, bigint | number | object> = {}): PartiallyDecodedInstruction {
  return {
    programId: PROGRAM_ID,
    accounts: instructionAccounts(name, market),
    data: bs58.encode(coder.encode(name, encodeArgs(data))),
  };
}

function tokenBalance(mint: PublicKey, amount: number) {
  return {
    accountIndex: 0,
    mint: mint.toBase58(),
    owner: wallet.toBase58(),
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount: {
      amount: String(amount),
      decimals: mint.equals(usdcMint) ? 6 : 0,
      uiAmount: null,
      uiAmountString: String(amount),
    },
  };
}

function buildTx(args: {
  slot: number;
  blockTime: number;
  instructions: PartiallyDecodedInstruction[];
  pre: Array<{ mint: PublicKey; amount: number }>;
  post: Array<{ mint: PublicKey; amount: number }>;
}): ParsedTransactionWithMeta {
  return {
    blockTime: args.blockTime,
    slot: args.slot,
    meta: {
      err: null,
      preTokenBalances: args.pre.map((item) => tokenBalance(item.mint, item.amount)),
      postTokenBalances: args.post.map((item) => tokenBalance(item.mint, item.amount)),
    },
    transaction: {
      signatures: [`sig-${args.slot}`],
      message: {
        instructions: args.instructions,
      },
    },
  } as ParsedTransactionWithMeta;
}

test("derives cost basis and realized pnl for buy_yes then partial sell_yes", () => {
  const transactions = [
    buildTx({
      slot: 1,
      blockTime: 10,
      instructions: [buildInstruction("buy_yes", { amount: 2, max_price: 400_000 })],
      pre: [{ mint: usdcMint, amount: 5_000_000 }],
      post: [
        { mint: usdcMint, amount: 4_200_000 },
        { mint: yesMint, amount: 2 },
      ],
    }),
    buildTx({
      slot: 2,
      blockTime: 20,
      instructions: [buildInstruction("sell_yes", { amount: 1, min_price: 550_000 })],
      pre: [
        { mint: usdcMint, amount: 4_200_000 },
        { mint: yesMint, amount: 2 },
      ],
      post: [
        { mint: usdcMint, amount: 4_750_000 },
        { mint: yesMint, amount: 1 },
      ],
    }),
  ];

  const positions: Position[] = [{ ...basePosition, yesBalance: 1 }];
  const performance = derivePositionPerformanceFromTransactions(transactions, wallet, positions, usdcMint);
  const meta = performance.get(market.toBase58());

  assert(meta);
  assert.equal(meta.yesEntryPrice, 400_000);
  assert.equal(meta.costBasis, 0.4);
  assertApprox(meta.realizedPnl, 0.15);
  assert.equal(meta.pairedContracts, 0);
});

test("derives no-side entry price and realized pnl for buy_no then sell_no", () => {
  const transactions = [
    buildTx({
      slot: 1,
      blockTime: 10,
      instructions: [
        buildInstruction("mint_pair", { amount: 2 }),
        buildInstruction("sell_yes", { amount: 2, min_price: 650_000 }),
      ],
      pre: [{ mint: usdcMint, amount: 5_000_000 }],
      post: [
        { mint: usdcMint, amount: 4_300_000 },
        { mint: noMint, amount: 2 },
      ],
    }),
    buildTx({
      slot: 2,
      blockTime: 20,
      instructions: [
        buildInstruction("buy_yes", { amount: 1, max_price: 750_000 }),
        buildInstruction("redeem", { amount: 1 }),
      ],
      pre: [
        { mint: usdcMint, amount: 4_300_000 },
        { mint: noMint, amount: 2 },
      ],
      post: [
        { mint: usdcMint, amount: 4_550_000 },
        { mint: noMint, amount: 1 },
      ],
    }),
  ];

  const positions: Position[] = [{ ...basePosition, noBalance: 1 }];
  const performance = derivePositionPerformanceFromTransactions(transactions, wallet, positions, usdcMint);
  const meta = performance.get(market.toBase58());

  assert(meta);
  assert.equal(meta.noEntryPrice, 350_000);
  assert.equal(meta.costBasis, 0.35);
  assertApprox(meta.realizedPnl, -0.1);
});

test("tracks paired complete-set inventory and pair redemption", () => {
  const transactions = [
    buildTx({
      slot: 1,
      blockTime: 10,
      instructions: [buildInstruction("mint_pair", { amount: 3 })],
      pre: [{ mint: usdcMint, amount: 5_000_000 }],
      post: [
        { mint: usdcMint, amount: 2_000_000 },
        { mint: yesMint, amount: 3 },
        { mint: noMint, amount: 3 },
      ],
    }),
    buildTx({
      slot: 2,
      blockTime: 20,
      instructions: [buildInstruction("redeem", { amount: 1 })],
      pre: [
        { mint: usdcMint, amount: 2_000_000 },
        { mint: yesMint, amount: 3 },
        { mint: noMint, amount: 3 },
      ],
      post: [
        { mint: usdcMint, amount: 3_000_000 },
        { mint: yesMint, amount: 2 },
        { mint: noMint, amount: 2 },
      ],
    }),
  ];

  const positions: Position[] = [{ ...basePosition, yesBalance: 2, noBalance: 2 }];
  const performance = derivePositionPerformanceFromTransactions(transactions, wallet, positions, usdcMint);
  const meta = performance.get(market.toBase58());

  assert(meta);
  assert.equal(meta.pairEntryPrice, 1_000_000);
  assert.equal(meta.pairedContracts, 2);
  assert.equal(meta.costBasis, 2);
  assert.equal(meta.realizedPnl, 0);
  assert.equal(meta.partialHistory, false);
});

test("marks inventory as partial history when current holdings exceed reconstructed coverage", () => {
  const transactions = [
    buildTx({
      slot: 1,
      blockTime: 10,
      instructions: [buildInstruction("buy_yes", { amount: 1, max_price: 400_000 })],
      pre: [{ mint: usdcMint, amount: 5_000_000 }],
      post: [
        { mint: usdcMint, amount: 4_600_000 },
        { mint: yesMint, amount: 1 },
      ],
    }),
  ];

  const positions: Position[] = [{ ...basePosition, yesBalance: 2 }];
  const performance = derivePositionPerformanceFromTransactions(transactions, wallet, positions, usdcMint);
  const meta = performance.get(market.toBase58());

  assert(meta);
  assert.equal(meta.partialHistory, true);
  assert.equal(meta.yesEntryPrice, null);
  assert.equal(meta.costBasis, null);
  assert.equal(meta.unrealizedPnl, null);
});

test("ignores non-meridian transactions and leaves realized pnl rounded to zero", () => {
  const transactions = [
    {
      blockTime: 10,
      slot: 1,
      meta: {
        err: null,
        fee: 0,
        preBalances: [],
        postBalances: [],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      transaction: {
        signatures: ["sig-unrelated"],
        message: {
          accountKeys: [],
          recentBlockhash: "11111111111111111111111111111111",
          instructions: [],
        },
      },
    } as ParsedTransactionWithMeta,
  ];

  const positions: Position[] = [{ ...basePosition, yesBalance: 0 }];
  const performance = derivePositionPerformanceFromTransactions(transactions, wallet, positions, usdcMint);
  const meta = performance.get(market.toBase58());

  assert(meta);
  assert.equal(meta.realizedPnl, 0);
  assert.equal(meta.partialHistory, false);
});
