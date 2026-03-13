import * as anchor from "@coral-xyz/anchor";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  setupTestContext,
  createMarket,
  mintPairForAdmin,
  mintPairForUser,
  createFundedUser,
  placeBid,
  placeAsk,
  buyYes,
} from "./helpers";

/**
 * Tests the single-call activity pattern: getSignaturesForAddress(PROGRAM_ID)
 * must return signatures for all program instructions across all markets.
 * This is the core invariant the activity feed depends on after the N-call
 * fan-out was replaced with a single program-level fetch.
 */
describe("activity: single-call signature pattern", () => {
  let ctx: Awaited<ReturnType<typeof setupTestContext>>;
  const PROGRAM_ID = new PublicKey("GMwKXYNKRkN3wGdgAwR4BzG2RfPGGLGjehuoNwUzBGk2");

  before(async () => {
    ctx = await setupTestContext();
  });

  it("getSignaturesForAddress(PROGRAM_ID) captures create + mint + order activity", async () => {
    const date = new anchor.BN(ctx.uniqueTestSeedBase + 9000);
    const strike = new anchor.BN(700_000_000);
    const market = await createMarket(ctx, "NVDA", strike, date);

    // Mint pairs
    await mintPairForAdmin(ctx, market, 10);

    // Place a bid on the order book
    const userYes = getAssociatedTokenAddressSync(market.yesMintPda, ctx.admin.publicKey);
    await placeBid(ctx, market, ctx.admin.publicKey, ctx.adminUsdcAta, userYes, 400_000, 2);

    // Fetch signatures for the program ID (the single-call pattern)
    const sigs = await ctx.provider.connection.getSignaturesForAddress(
      PROGRAM_ID,
      { limit: 50 },
      "confirmed"
    );
    const sigStrings = sigs.map((s) => s.signature);

    // Must have at least 3 sigs: createStrikeMarket, mintPair, placeOrder
    // (initializeConfig may also appear from earlier test setup)
    expect(sigStrings.length).to.be.greaterThanOrEqual(3);

    // Decode and verify we can find our instruction types
    const txs = await ctx.provider.connection.getParsedTransactions(
      sigStrings.slice(0, 20),
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
    );

    const coder = new BorshInstructionCoder(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../target/idl/meridian.json") as Idl // eslint-disable-line @typescript-eslint/no-require-imports
    );
    const decodedNames = new Set<string>();

    for (const tx of txs) {
      if (!tx) continue;
      for (const ix of tx.transaction.message.instructions) {
        if (!("data" in ix)) continue;
        if (!ix.programId.equals(PROGRAM_ID)) continue;
        try {
          const decoded = coder.decode(Buffer.from(
            bs58.decode(ix.data)
          ));
          if (decoded) decodedNames.add(decoded.name);
        } catch {
          // non-program instructions
        }
      }
    }

    // The core assertion: program-level signature fetch finds all instruction types
    expect(decodedNames.has("createStrikeMarket")).to.be.true;
    expect(decodedNames.has("mintPair")).to.be.true;
    expect(decodedNames.has("placeOrder")).to.be.true;
  });

  it("program-level fetch includes activity from multiple tickers", async () => {
    const date = new anchor.BN(ctx.uniqueTestSeedBase + 9001);
    const strike = new anchor.BN(250_000_000);

    // Create a second market with a different ticker
    const marketA = await createMarket(ctx, "AAPL", strike, date);
    await mintPairForAdmin(ctx, marketA, 5);

    const marketN = await createMarket(ctx, "NVDA", new anchor.BN(800_000_000), date);
    await mintPairForAdmin(ctx, marketN, 5);

    const sigs = await ctx.provider.connection.getSignaturesForAddress(
      PROGRAM_ID,
      { limit: 50 },
      "confirmed"
    );

    // Fetch the transactions and check that we see market addresses from both tickers
    const txs = await ctx.provider.connection.getParsedTransactions(
      sigs.map((s) => s.signature).slice(0, 30),
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
    );

    const marketAddressesSeen = new Set<string>();
    for (const tx of txs) {
      if (!tx) continue;
      for (const ix of tx.transaction.message.instructions) {
        if (!("accounts" in ix)) continue;
        if (!ix.programId.equals(PROGRAM_ID)) continue;
        // The market account is typically the second or third account in our instructions
        for (const acct of ix.accounts) {
          const key = acct.toBase58();
          if (key === marketA.marketPda.toBase58() || key === marketN.marketPda.toBase58()) {
            marketAddressesSeen.add(key);
          }
        }
      }
    }

    expect(marketAddressesSeen.has(marketA.marketPda.toBase58())).to.be.true;
    expect(marketAddressesSeen.has(marketN.marketPda.toBase58())).to.be.true;
  });

  it("taker fills (buyYes) appear in program-level fetch", async () => {
    const date = new anchor.BN(ctx.uniqueTestSeedBase + 9002);
    const strike = new anchor.BN(600_000_000);
    const market = await createMarket(ctx, "MSFT", strike, date);

    // Setup: maker places ask, fund a taker
    const { user: maker, userUsdc: makerUsdc } = await createFundedUser(ctx);
    const makerYes = await createAssociatedTokenAccount(
      ctx.provider.connection, ctx.mintAuthority, market.yesMintPda, maker.publicKey
    );
    await createAssociatedTokenAccount(
      ctx.provider.connection, ctx.mintAuthority, market.noMintPda, maker.publicKey
    );
    await mintPairForUser(ctx, maker.publicKey, makerUsdc, market, 10, [maker]);
    await placeAsk(ctx, market, maker.publicKey, makerUsdc, makerYes, 600_000, 5, { signers: [maker] });

    // Taker buys yes
    const { user: taker, userUsdc: takerUsdc } = await createFundedUser(ctx);
    const takerYes = await createAssociatedTokenAccount(
      ctx.provider.connection, ctx.mintAuthority, market.yesMintPda, taker.publicKey
    );
    await buyYes(ctx, market, taker.publicKey, takerUsdc, takerYes, 700_000, 3, { signers: [taker] });

    const sigs = await ctx.provider.connection.getSignaturesForAddress(
      PROGRAM_ID,
      { limit: 20 },
      "confirmed"
    );

    const coder = new BorshInstructionCoder(
      require("../target/idl/meridian.json") as Idl // eslint-disable-line @typescript-eslint/no-require-imports
    );
    const txs = await ctx.provider.connection.getParsedTransactions(
      sigs.map((s) => s.signature).slice(0, 15),
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
    );

    const foundBuyYes = txs.some((tx) => {
      if (!tx) return false;
      return tx.transaction.message.instructions.some((ix) => {
        if (!("data" in ix) || !ix.programId.equals(PROGRAM_ID)) return false;
        try {
          const decoded = coder.decode(Buffer.from(
            bs58.decode(ix.data)
          ));
          return decoded?.name === "buyYes";
        } catch { return false; }
      });
    });

    expect(foundBuyYes).to.be.true;
  });
});
