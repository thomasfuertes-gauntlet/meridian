import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  setupTestContext,
  TestContext,
  createMarket,
  createFundedUser,
  mintPairForAdmin,
  adminSettleMarket,
  freezeMarket,
  placeBid,
  placeAsk,
  buyYes,
  cancelOrder,
  createMockPriceUpdate,
  buildMockPriceUpdateV2Data,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────
//  HARDENING TESTS
//
//  Coverage gaps identified during security audit (2026-03-15).
//  Tests account substitution, admin gates, order book boundaries,
//  oracle edge cases, and state machine violations.
// ─────────────────────────────────────────────────────────────────

const NVDA_FEED_ID = Array.from(
  Buffer.from(
    "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    "hex"
  )
);

describe("hardening: account substitution", () => {
  let ctx: TestContext;
  let idx: number;
  const nextDate = () => new anchor.BN(idx++);

  before(async () => {
    ctx = await setupTestContext();
    idx = ctx.uniqueTestSeedBase + 30_000;
  });

  it("mint_pair rejects user_usdc with wrong mint", async () => {
    const pdas = await createMarket(ctx, "NVDA", new anchor.BN(500_000_000), nextDate());

    // Create a fake token mint and ATA for admin
    const fakeMint = await createMint(
      ctx.provider.connection,
      ctx.mintAuthority,
      ctx.mintAuthority.publicKey,
      null,
      6
    );
    const fakeAta = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      fakeMint,
      ctx.admin.publicKey
    );
    await mintTo(ctx.provider.connection, ctx.mintAuthority, fakeMint, fakeAta, ctx.mintAuthority, 10_000_000);

    try {
      await ctx.program.methods
        .mintPair(new anchor.BN(1))
        .accountsPartial({
          user: ctx.admin.publicKey,
          market: pdas.marketPda,
          userUsdc: fakeAta, // wrong mint
          vault: pdas.vaultPda,
          yesMint: pdas.yesMintPda,
          noMint: pdas.noMintPda,
          userYes: getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey, true),
          userNo: getAssociatedTokenAddressSync(pdas.noMintPda, ctx.admin.publicKey, true),
        })
        .rpc();
      expect.fail("Should have rejected wrong mint");
    } catch (err: any) {
      expect(err.toString()).to.match(/ConstraintTokenMint|MintMismatch|0x7d3/);
    }
  });

  it("buy_yes rejects user_usdc with wrong mint", async () => {
    const pdas = await createMarket(ctx, "AAPL", new anchor.BN(200_000_000), nextDate());
    await mintPairForAdmin(ctx, pdas, 5);

    const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey);
    await placeAsk(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 400_000, 3);

    const { user } = await createFundedUser(ctx);

    // Create a fake mint ATA for the buyer
    const fakeMint = await createMint(ctx.provider.connection, ctx.mintAuthority, ctx.mintAuthority.publicKey, null, 6);
    const fakeAta = await createAssociatedTokenAccount(ctx.provider.connection, ctx.mintAuthority, fakeMint, user.publicKey);
    await mintTo(ctx.provider.connection, ctx.mintAuthority, fakeMint, fakeAta, ctx.mintAuthority, 10_000_000);

    const userYes = await createAssociatedTokenAccount(ctx.provider.connection, ctx.mintAuthority, pdas.yesMintPda, user.publicKey);

    try {
      await buyYes(ctx, pdas, user.publicKey, fakeAta, userYes, 500_000, 1, { signers: [user] });
      expect.fail("Should have rejected wrong mint");
    } catch (err: any) {
      expect(err.toString()).to.match(/ConstraintTokenMint|MintMismatch|0x7d3/);
    }
  });
});

describe("hardening: admin gates", () => {
  let ctx: TestContext;
  let nonAdmin: Keypair;
  let idx: number;
  const nextDate = () => new anchor.BN(idx++);

  before(async () => {
    ctx = await setupTestContext();
    idx = ctx.uniqueTestSeedBase + 31_000;

    nonAdmin = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(nonAdmin.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await ctx.provider.connection.confirmTransaction(sig);
  });

  it("non-admin cannot admin_settle", async () => {
    const pdas = await createMarket(ctx, "META", new anchor.BN(600_000_000), nextDate());
    await freezeMarket(ctx, pdas);

    try {
      await ctx.program.methods
        .adminSettle(new anchor.BN(700_000_000))
        .accountsPartial({
          admin: nonAdmin.publicKey,
          config: ctx.configPda,
          market: pdas.marketPda,
        })
        .remainingAccounts([{ pubkey: pdas.orderBookPda, isWritable: true, isSigner: false }])
        .signers([nonAdmin])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|2012/);
    }
  });

  it("non-admin cannot close_market", async () => {
    const pdas = await createMarket(ctx, "TSLA", new anchor.BN(300_000_000), nextDate());
    await adminSettleMarket(ctx, pdas, new anchor.BN(400_000_000));

    try {
      await ctx.program.methods
        .closeMarket()
        .accountsPartial({
          admin: nonAdmin.publicKey,
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
        })
        .signers([nonAdmin])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|2012/);
    }
  });

  it("non-admin cannot update_config", async () => {
    try {
      await ctx.program.methods
        .updateConfig(new anchor.BN(0))
        .accountsPartial({
          admin: nonAdmin.publicKey,
          config: ctx.configPda,
        })
        .signers([nonAdmin])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|2012/);
    }
  });

  it("close_market rejects Frozen (not settled) market", async () => {
    const pdas = await createMarket(ctx, "GOOGL", new anchor.BN(180_000_000), nextDate());
    await freezeMarket(ctx, pdas);

    try {
      await ctx.program.methods
        .closeMarket()
        .accountsPartial({
          admin: ctx.admin.publicKey,
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
        })
        .rpc();
      expect.fail("Should have thrown MarketNotSettled");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketNotSettled");
    }
  });
});

describe("hardening: order book boundaries", () => {
  let ctx: TestContext;
  let idx: number;
  const nextDate = () => new anchor.BN(idx++);

  before(async () => {
    ctx = await setupTestContext();
    idx = ctx.uniqueTestSeedBase + 32_000;
  });

  it("rejects 33rd order on bid side (OrderBookFull)", async () => {
    const pdas = await createMarket(ctx, "NVDA", new anchor.BN(800_000_000), nextDate());

    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection, ctx.mintAuthority, pdas.yesMintPda, ctx.admin.publicKey
    );

    // Place 32 bids at different prices to fill the book
    for (let i = 0; i < 32; i++) {
      await placeBid(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 10_000 + i, 1);
    }

    // 33rd should fail
    try {
      await placeBid(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 9_000, 1);
      expect.fail("Should have thrown OrderBookFull");
    } catch (err: any) {
      expect(err.toString()).to.include("OrderBookFull");
    }
  });

  it("rejects 33rd order on ask side (OrderBookFull)", async () => {
    const pdas = await createMarket(ctx, "AAPL", new anchor.BN(250_000_000), nextDate());

    // Need Yes tokens for asks
    await mintPairForAdmin(ctx, pdas, 35);
    const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey);

    // Place 32 asks at different prices
    for (let i = 0; i < 32; i++) {
      await placeAsk(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000 + i, 1);
    }

    // 33rd should fail
    try {
      await placeAsk(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 999_000, 1);
      expect.fail("Should have thrown OrderBookFull");
    } catch (err: any) {
      expect(err.toString()).to.include("OrderBookFull");
    }
  });

  it("cancel someone else's order fails (NotOrderOwner)", async () => {
    const pdas = await createMarket(ctx, "META", new anchor.BN(650_000_000), nextDate());

    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection, ctx.mintAuthority, pdas.yesMintPda, ctx.admin.publicKey
    );

    // Admin places a bid
    await placeBid(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 400_000, 1);

    // Non-admin tries to cancel it
    const { user, userUsdc } = await createFundedUser(ctx);

    try {
      await cancelOrder(ctx, pdas, 1, user.publicKey, userUsdc, [user]);
      expect.fail("Should have thrown NotOrderOwner");
    } catch (err: any) {
      expect(err.toString()).to.include("NotOrderOwner");
    }
  });
});

describe("hardening: oracle edge cases", () => {
  let ctx: TestContext;
  let idx: number;
  const nextDate = () => new anchor.BN(idx++);

  before(async () => {
    ctx = await setupTestContext();
    idx = ctx.uniqueTestSeedBase + 33_000;
  });

  it("rejects stale oracle price (outside settlement window)", async () => {
    const date = nextDate();
    const closeTime = date.add(new anchor.BN(3600));
    const pdas = await createMarket(ctx, "NVDA", new anchor.BN(500_000_000), date, closeTime);
    await freezeMarket(ctx, pdas);

    // Publish time way before close_time (stale)
    const stalePublishTime = closeTime.toNumber() - 600;
    const priceUpdate = await createMockPriceUpdate(ctx.provider, {
      feedId: NVDA_FEED_ID,
      priceDollars: 600,
      publishTime: stalePublishTime,
    });

    try {
      await ctx.program.methods
        .settleMarket()
        .accountsPartial({
          settler: ctx.admin.publicKey,
          config: ctx.configPda,
          market: pdas.marketPda,
          priceUpdate,
        })
        .remainingAccounts([{ pubkey: pdas.orderBookPda, isWritable: true, isSigner: false }])
        .rpc();
      expect.fail("Should have thrown InvalidSettlementWindow");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidSettlementWindow");
    }
  });

  it("rejects oracle price with wide confidence band", async () => {
    const date = nextDate();
    const closeTime = date.add(new anchor.BN(3600));
    const pdas = await createMarket(ctx, "NVDA", new anchor.BN(500_000_000), date, closeTime);
    await freezeMarket(ctx, pdas);

    const publishTime = closeTime.toNumber() + 60;
    // Build data with default confidence, then patch it to be absurdly wide
    const data = buildMockPriceUpdateV2Data({
      writeAuthority: ctx.admin.publicKey,
      feedId: NVDA_FEED_ID,
      priceDollars: 600,
      exponent: -8,
      publishTime,
    });
    // Overwrite confidence at offset 81 to 20% of price (way above 1% filter)
    const rawPrice = data.readBigInt64LE(73);
    const wideConf = (rawPrice < 0n ? -rawPrice : rawPrice) / 5n;
    data.writeBigUInt64LE(wideConf, 81);

    // Create account via mock-pyth with proper 2-key instruction format
    const priceAccount = Keypair.generate();
    const { SystemProgram, Transaction, TransactionInstruction } = await import("@solana/web3.js");
    const { PYTH_RECEIVER_PROGRAM_ID, PRICE_UPDATE_V2_SIZE } = await import("../scripts/mock-pyth");
    const lamports = await ctx.provider.connection.getMinimumBalanceForRentExemption(PRICE_UPDATE_V2_SIZE);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: ctx.admin.publicKey,
        newAccountPubkey: priceAccount.publicKey,
        lamports,
        space: PRICE_UPDATE_V2_SIZE,
        programId: PYTH_RECEIVER_PROGRAM_ID,
      }),
      new TransactionInstruction({
        programId: PYTH_RECEIVER_PROGRAM_ID,
        keys: [
          { pubkey: ctx.admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: priceAccount.publicKey, isSigner: false, isWritable: true },
        ],
        data,
      })
    );
    await ctx.provider.sendAndConfirm(tx, [priceAccount]);

    try {
      await ctx.program.methods
        .settleMarket()
        .accountsPartial({
          settler: ctx.admin.publicKey,
          config: ctx.configPda,
          market: pdas.marketPda,
          priceUpdate: priceAccount.publicKey,
        })
        .remainingAccounts([{ pubkey: pdas.orderBookPda, isWritable: true, isSigner: false }])
        .rpc();
      expect.fail("Should have thrown PriceConfidenceTooWide");
    } catch (err: any) {
      expect(err.toString()).to.include("PriceConfidenceTooWide");
    }
  });
});

describe("hardening: state machine", () => {
  let ctx: TestContext;
  let idx: number;
  const nextDate = () => new anchor.BN(idx++);

  before(async () => {
    ctx = await setupTestContext();
    idx = ctx.uniqueTestSeedBase + 34_000;
  });

  it("mint_pair rejects on Frozen market", async () => {
    const pdas = await createMarket(ctx, "MSFT", new anchor.BN(400_000_000), nextDate());
    await freezeMarket(ctx, pdas);

    try {
      await mintPairForAdmin(ctx, pdas, 1);
      expect.fail("Should have thrown MarketFrozen");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketFrozen");
    }
  });

  it("place_order rejects on Frozen market", async () => {
    const pdas = await createMarket(ctx, "AMZN", new anchor.BN(180_000_000), nextDate());
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection, ctx.mintAuthority, pdas.yesMintPda, ctx.admin.publicKey
    );
    await freezeMarket(ctx, pdas);

    try {
      await placeBid(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 400_000, 1);
      expect.fail("Should have thrown MarketFrozen");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketFrozen");
    }
  });

  it("freeze_market is permissionless after close_time", async () => {
    const date = nextDate();
    const pdas = await createMarket(ctx, "TSLA", new anchor.BN(300_000_000), date);

    // Non-admin can freeze
    const { user } = await createFundedUser(ctx);
    await ctx.program.methods
      .freezeMarket()
      .accountsPartial({
        authority: user.publicKey,
        config: ctx.configPda,
        market: pdas.marketPda,
      })
      .signers([user])
      .rpc();

    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(market.status).to.deep.equal({ frozen: {} });
  });
});
