import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import {
  setupTestContext,
  TestContext,
  deriveMarketPdas,
  createMarket,
  mintPairForAdmin,
  mintPairForUser,
  adminSettleMarket,
  placeBid,
  placeAsk,
  tokenAmount,
  expectIncrease,
  expectDecrease,
  mintUsdc,
} from "./helpers";

describe("order book", () => {
  let ctx: TestContext;
  let userB: Keypair;
  let userBUsdc: PublicKey;

  let obMarketIdx: number;

  function nextDate() {
    return new anchor.BN(obMarketIdx++);
  }

  async function createMarketWithOB(ticker: string, strikePrice: anchor.BN) {
    const date = nextDate();
    const pdas = await createMarket(ctx, ticker, strikePrice, date);
    return { ...pdas, date };
  }

  async function mintPairsFor(
    pdas: ReturnType<typeof deriveMarketPdas>,
    userKey: PublicKey,
    userUsdcAta: PublicKey,
    count: number,
    signers?: Keypair[]
  ) {
    const userYes = getAssociatedTokenAddressSync(pdas.yesMintPda, userKey);
    const userNo = getAssociatedTokenAddressSync(pdas.noMintPda, userKey);

    const tx = ctx.program.methods
      .mintPair(new anchor.BN(count))
      .accountsPartial({
        user: userKey,
        market: pdas.marketPda,
        userUsdc: userUsdcAta,
        vault: pdas.vaultPda,
        yesMint: pdas.yesMintPda,
        noMint: pdas.noMintPda,
        userYes,
        userNo,
      });
    if (signers) {
      await tx.signers(signers).rpc();
    } else {
      await tx.rpc();
    }
  }

  before(async () => {
    ctx = await setupTestContext();
    obMarketIdx = ctx.uniqueTestSeedBase;

    userB = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(
      userB.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(sig);
    userBUsdc = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      ctx.usdcMint,
      userB.publicKey
    );
    await mintUsdc(ctx, userBUsdc, 50_000_000);
  });

  it("create_strike_market initializes order book + escrow vaults", async () => {
    const date = nextDate();
    const pdas = await createMarket(ctx, "OB1", new anchor.BN(100_000_000), date);

    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(market.orderBook.toBase58()).to.equal(pdas.orderBookPda.toBase58());
    expect(market.obUsdcVault.toBase58()).to.equal(pdas.obUsdcVault.toBase58());
    expect(market.obYesVault.toBase58()).to.equal(pdas.obYesVault.toBase58());

    const ob = await ctx.program.account.orderBook.fetch(pdas.orderBookPda);
    expect(ob.market.toBase58()).to.equal(pdas.marketPda.toBase58());
    expect(ob.bidCount).to.equal(0);
    expect(ob.askCount).to.equal(0);
    expect(ob.nextOrderId.toNumber()).to.equal(1);

    const usdcVault = await getAccount(ctx.provider.connection, pdas.obUsdcVault);
    expect(Number(usdcVault.amount)).to.equal(0);
    const yesVault = await getAccount(ctx.provider.connection, pdas.obYesVault);
    expect(Number(yesVault.amount)).to.equal(0);
  });

  it("places a resting bid (no match)", async () => {
    const m = await createMarketWithOB("OB3", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    const usdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);

    await placeBid(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 3);

    const usdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    expect(usdcBefore - usdcAfter).to.equal(1_500_000);

    const ob = await ctx.program.account.orderBook.fetch(m.orderBookPda);
    expect(ob.bidCount).to.equal(1);
    expect(ob.askCount).to.equal(0);
    expect(ob.bids[0].price.toNumber()).to.equal(500_000);
    expect(ob.bids[0].quantity.toNumber()).to.equal(3);
    expect(ob.bids[0].owner.toBase58()).to.equal(ctx.admin.publicKey.toBase58());
  });

  it("places a resting ask (no match)", async () => {
    const m = await createMarketWithOB("OB4", new anchor.BN(100_000_000));

    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 2);

    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);
    const yesBefore = await tokenAmount(ctx, adminYes);

    await placeAsk(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 700_000, 2);

    const yesAfter = await tokenAmount(ctx, adminYes);
    expect(yesBefore - yesAfter).to.equal(2);

    const ob = await ctx.program.account.orderBook.fetch(m.orderBookPda);
    expect(ob.askCount).to.equal(1);
    expect(ob.bidCount).to.equal(0);
    expect(ob.asks[0].price.toNumber()).to.equal(700_000);
    expect(ob.asks[0].quantity.toNumber()).to.equal(2);
  });

  it("crossing bid is rejected and must use buy_yes", async () => {
    const m = await createMarketWithOB("OB5", new anchor.BN(100_000_000));

    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 2);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    await placeAsk(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 2);

    await mintUsdc(ctx, userBUsdc, 5_000_000);
    const userBYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      userB,
      m.yesMintPda,
      userB.publicKey
    );

    try {
      await placeBid(ctx, m, userB.publicKey, userBUsdc, userBYes, 600_000, 3, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
    }
  });

  it("crossing bid rejects before counterparty-account validation", async () => {
    const m = await createMarketWithOB("OB_M", new anchor.BN(100_000_000));

    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    await placeAsk(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 1);

    await mintUsdc(ctx, userBUsdc, 1_000_000);
    const userBYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      userB,
      m.yesMintPda,
      userB.publicKey
    );

    try {
      await placeBid(ctx, m, userB.publicKey, userBUsdc, userBYes, 500_000, 1, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
    }
  });

  it("crossing bid ignores attacker-controlled remaining accounts and rejects early", async () => {
    const m = await createMarketWithOB("OB_M2", new anchor.BN(100_000_000));

    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    await placeAsk(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 1);

    const userBYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      userB,
      m.yesMintPda,
      userB.publicKey
    );
    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);

    try {
      await placeBid(ctx, m, userB.publicKey, userBUsdc, userBYes, 500_000, 1, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
    }

    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    expect(adminUsdcAfter).to.equal(adminUsdcBefore);
    expect(userBUsdcAfter).to.equal(userBUsdcBefore);
    expect(userBYesAfter).to.equal(0);
  });

  it("crossing partial-fill attempts are rejected and must use dedicated taker flows", async () => {
    const m = await createMarketWithOB("OB6", new anchor.BN(100_000_000));

    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 5);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    await placeAsk(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 400_000, 5);

    await mintUsdc(ctx, userBUsdc, 2_000_000);
    const userBYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      userB,
      m.yesMintPda,
      userB.publicKey
    );

    try {
      await placeBid(ctx, m, userB.publicKey, userBUsdc, userBYes, 400_000, 2, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
    }
  });

  it("market-style bid via place_order is rejected and must use buy_yes", async () => {
    const m = await createMarketWithOB("OB7", new anchor.BN(100_000_000));

    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 3);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    await placeAsk(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 300_000, 1);
    await placeAsk(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 600_000, 2);

    await mintUsdc(ctx, userBUsdc, 5_000_000);
    const userBYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      userB,
      m.yesMintPda,
      userB.publicKey
    );

    try {
      await placeBid(ctx, m, userB.publicKey, userBUsdc, userBYes, 999_999, 3, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
    }
  });

  it("cancels a resting bid and refunds USDC", async () => {
    const m = await createMarketWithOB("OB8", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    const usdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);

    await placeBid(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 4);

    const ob = await ctx.program.account.orderBook.fetch(m.orderBookPda);
    const orderId = ob.bids[0].orderId;

    await ctx.program.methods
      .cancelOrder(orderId)
      .accountsPartial({
        user: ctx.admin.publicKey,
        market: m.marketPda,
        orderBook: m.orderBookPda,
        obUsdcVault: m.obUsdcVault,
        obYesVault: m.obYesVault,
        refundDestination: ctx.adminUsdcAta,
      })
      .rpc();

    const usdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    expect(usdcAfter).to.equal(usdcBefore);

    const ob2 = await ctx.program.account.orderBook.fetch(m.orderBookPda);
    expect(ob2.bidCount).to.equal(0);
  });

  it("cancel_order conserves bid escrow exactly across vault and refund destination", async () => {
    const m = await createMarketWithOB("OB8C", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    await placeBid(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 450_000, 3);

    const ob = await ctx.program.account.orderBook.fetch(m.orderBookPda);
    const orderId = ob.bids[0].orderId;
    const usdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    const obUsdcBefore = await tokenAmount(ctx, m.obUsdcVault);

    await ctx.program.methods
      .cancelOrder(orderId)
      .accountsPartial({
        user: ctx.admin.publicKey,
        market: m.marketPda,
        orderBook: m.orderBookPda,
        obUsdcVault: m.obUsdcVault,
        obYesVault: m.obYesVault,
        refundDestination: ctx.adminUsdcAta,
      })
      .rpc();

    const usdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const obUsdcAfter = await tokenAmount(ctx, m.obUsdcVault);
    const refunded = 3 * 450_000;

    expectIncrease(usdcBefore, usdcAfter, refunded);
    expectDecrease(obUsdcBefore, obUsdcAfter, refunded);
    expect(obUsdcAfter).to.equal(0);
  });

  it("cancels a resting ask and refunds Yes tokens", async () => {
    const m = await createMarketWithOB("OB9", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 3);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    const yesBefore = await tokenAmount(ctx, adminYes);

    await placeAsk(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 700_000, 3);

    const ob = await ctx.program.account.orderBook.fetch(m.orderBookPda);
    const orderId = ob.asks[0].orderId;

    await ctx.program.methods
      .cancelOrder(orderId)
      .accountsPartial({
        user: ctx.admin.publicKey,
        market: m.marketPda,
        orderBook: m.orderBookPda,
        obUsdcVault: m.obUsdcVault,
        obYesVault: m.obYesVault,
        refundDestination: adminYes,
      })
      .rpc();

    const yesAfter = await tokenAmount(ctx, adminYes);
    expect(yesAfter).to.equal(yesBefore);

    const ob2 = await ctx.program.account.orderBook.fetch(m.orderBookPda);
    expect(ob2.askCount).to.equal(0);
  });

  it("rejects cancel by non-owner on pending market (NotOrderOwner)", async () => {
    const m = await createMarketWithOB("OBX1", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    await placeBid(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 2);

    const ob = await ctx.program.account.orderBook.fetch(m.orderBookPda);
    const orderId = ob.bids[0].orderId;

    try {
      await ctx.program.methods
        .cancelOrder(orderId)
        .accountsPartial({
          user: userB.publicKey,
          market: m.marketPda,
          orderBook: m.orderBookPda,
          obUsdcVault: m.obUsdcVault,
          obYesVault: m.obYesVault,
          refundDestination: ctx.adminUsdcAta,
        })
        .signers([userB])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("NotOrderOwner");
    }
  });

  it("rejects cancel with non-existent order_id (OrderNotFound)", async () => {
    const m = await createMarketWithOB("OBX2", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);

    try {
      await ctx.program.methods
        .cancelOrder(new anchor.BN(99999))
        .accountsPartial({
          user: ctx.admin.publicKey,
          market: m.marketPda,
          orderBook: m.orderBookPda,
          obUsdcVault: m.obUsdcVault,
          obYesVault: m.obYesVault,
          refundDestination: ctx.adminUsdcAta,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("OrderNotFound");
    }
  });

  it("rejects price = 0", async () => {
    const m = await createMarketWithOB("OBB", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    try {
      await placeBid(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 0, 1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidPrice");
    }
  });

  it("rejects price = 1_000_000", async () => {
    const m = await createMarketWithOB("OBC", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    try {
      await placeBid(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 1_000_000, 1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidPrice");
    }
  });

  it("rejects quantity = 0", async () => {
    const m = await createMarketWithOB("OBD", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    try {
      await placeBid(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 0);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidAmount");
    }
  });

  it("rejects place_order on settled market", async () => {
    const m = await createMarketWithOB("OBE", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    await adminSettleMarket(ctx, m, new anchor.BN(110_000_000));

    try {
      await placeBid(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketAlreadySettled");
    }
  });

  it("rejects place_order when paused", async () => {
    const m = await createMarketWithOB("OBF", new anchor.BN(100_000_000));
    await mintPairsFor(m, ctx.admin.publicKey, ctx.adminUsdcAta, 1);
    const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, ctx.admin.publicKey);

    await ctx.program.methods
      .pause()
      .accountsPartial({ admin: ctx.admin.publicKey })
      .rpc();

    try {
      await placeBid(ctx, m, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("Paused");
    } finally {
      await ctx.program.methods
        .unpause()
        .accountsPartial({ admin: ctx.admin.publicKey })
        .rpc();
    }
  });
});

