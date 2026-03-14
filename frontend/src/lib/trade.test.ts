import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { Program } from "@coral-xyz/anchor";
import { buildBuyYesTx, buildSellYesTx, buildBuyNoTx, buildSellNoTx } from "./trade";

// ── Minimal Anchor Program mock ─────────────────────────────────────────────
// Each method returns a chainable object that resolves to a dummy instruction.
// This lets us verify instruction count (the meaningful composition invariant)
// without a live Solana connection.

const dummyIx = { programId: new PublicKey(0), keys: [], data: Buffer.from([]) };

function mockMethod() {
  // Handles both .accountsPartial().instruction() and
  // .accountsPartial().remainingAccounts().instruction() chains.
  const chain: Record<string, unknown> = {};
  chain.instruction = async () => dummyIx;
  chain.remainingAccounts = () => chain;
  chain.accountsPartial = () => chain;
  return () => chain;
}

const mockProgram = {
  methods: {
    buyYes: mockMethod(),
    sellYes: mockMethod(),
    mintPair: mockMethod(),
    redeem: mockMethod(),
    placeOrder: mockMethod(),
  },
} as unknown as Program;

const user = new PublicKey("5Ux797xeoqotK8b6qtjYWwfS2fv7p9ZLV9V2ZAcxiyo");
const market = new PublicKey("11111111111111111111111111111112");
const yesMint = new PublicKey("11111111111111111111111111111113");
const noMint = new PublicKey("11111111111111111111111111111114");
const usdcMint = new PublicKey("11111111111111111111111111111116");
const price = new BN(500_000);
const quantity = new BN(10);

const params = { program: mockProgram, user, market, yesMint, noMint, usdcMint, price, quantity };

// ── Instruction-count tests ─────────────────────────────────────────────────
// These verify the documented trade compositions:
//   Buy No  = mint_pair + sell_yes  (CLAUDE.md: "Buy No = mint_pair + sell_yes")
//   Sell No = buy_yes  + redeem     (CLAUDE.md: "Sell No = buy_yes + redeem")

test("buildBuyNoTx: 5 instructions (3 ATA creates + mintPair + sellYes)", async () => {
  const tx = await buildBuyNoTx(params);
  assert.equal(tx.instructions.length, 5);
});

test("buildSellNoTx: 5 instructions (3 ATA creates + buyYes + redeem)", async () => {
  const tx = await buildSellNoTx(params);
  assert.equal(tx.instructions.length, 5);
});

test("buildBuyYesTx: 3 instructions (2 ATA creates + buyYes)", async () => {
  const tx = await buildBuyYesTx(params);
  assert.equal(tx.instructions.length, 3);
});

test("buildSellYesTx: 3 instructions (2 ATA creates + sellYes)", async () => {
  const tx = await buildSellYesTx(params);
  assert.equal(tx.instructions.length, 3);
});
