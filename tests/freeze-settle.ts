import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import {
  setupTestContext,
  TestContext,
  createMarket,
  initOrderBookForMarket,
  mintPairForAdmin,
  mintPairForUser,
  tokenAccountsFor,
  userTokenAccounts,
  placeBid,
  placeAsk,
  buyYes,
  buyNo,
  sellNo,
  claimFills,
  freezeMarket,
  cancelOrder,
  adminSettleMarket,
  settleWithOrderBookProof,
  unwindOrderForSettlement,
  settlementProofAccounts,
  redeemForUser,
  transferTokens,
  tokenAmount,
  expectIncrease,
  expectDecrease,
  createFundedUser,
  getCurrentUnixTimestamp,
  createEmptyPriceUpdateAccount,
  PYTH_RECEIVER_PROGRAM_ID,
  buildMockPriceUpdateV2Data,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────
//  FROZEN MARKET BEHAVIOR
// ─────────────────────────────────────────────────────────────────

describe("frozen market behavior", () => {
  let ctx: TestContext;
  let userB: Keypair;
  let userBUsdc: PublicKey;
  let freezeMarketIdx = 1550000000;

  function nextFreezeDate() {
    return new anchor.BN(freezeMarketIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
    const funded = await createFundedUser(ctx, 20_000_000);
    userB = funded.user;
    userBUsdc = funded.userUsdc;
  });

  it("rejects mint_pair after market freeze", async () => {
    const pdas = await createMarket(ctx, "FRZM", new anchor.BN(270_000_000), nextFreezeDate());
    await freezeMarket(ctx, pdas);
    const { userYes, userNo } = userTokenAccounts(ctx, pdas);

    try {
      await ctx.methods
        .mintPair(new anchor.BN(1))
        .accountsPartial({
          user: ctx.admin.publicKey,
          market: pdas.marketPda,
          userUsdc: ctx.adminUsdcAta,
          vault: pdas.vaultPda,
          yesMint: pdas.yesMintPda,
          noMint: pdas.noMintPda,
          userYes,
          userNo,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketFrozen");
    }
  });

  it("rejects place_order after market freeze", async () => {
    const pdas = await createMarket(ctx, "FRZO", new anchor.BN(271_000_000), nextFreezeDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    await mintPairForAdmin(ctx, pdas, 1);
    const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey);

    await freezeMarket(ctx, pdas);

    try {
      await placeAsk(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketFrozen");
    }
  });

  it("rejects composed buy-no flow after market freeze while settlement still succeeds", async () => {
    const pdas = await createMarket(ctx, "FRZB", new anchor.BN(272_000_000), nextFreezeDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );
    const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

    await placeBid(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 650_000, 1);
    const obBefore = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);
    const bidOrderId = obBefore.bids[0].orderId;

    await freezeMarket(ctx, pdas);

    try {
      await buyNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 600_000, 1, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketFrozen");
    }

    await unwindOrderForSettlement(ctx, { ...pdas, ...obPdas }, bidOrderId, ctx.adminUsdcAta, adminYes);
    await settleWithOrderBookProof(ctx, { ...pdas, ...obPdas }, new anchor.BN(300_000_000));

    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(market.outcome).to.deep.equal({ yesWins: {} });
  });

  it("rejects buy_yes after market freeze", async () => {
    const pdas = await createMarket(ctx, "FRZY", new anchor.BN(273_000_000), nextFreezeDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey);
    const userBYes = getAssociatedTokenAddressSync(pdas.yesMintPda, userB.publicKey);

    await mintPairForAdmin(ctx, pdas, 1);
    await placeAsk(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 1);
    await freezeMarket(ctx, pdas);

    try {
      await buyYes(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, 500_000, 1, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketFrozen");
    }
  });

  it("rejects composed sell-no flow after market settles", async () => {
    const closedAt = await getCurrentUnixTimestamp(ctx);
    const marketDate = new anchor.BN(closedAt - 3_700);
    const pdas = await createMarket(
      ctx, "STNO", new anchor.BN(274_000_000),
      marketDate, new anchor.BN(closedAt - 3_600)
    );
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const { userYes: userBYes, userNo: userBNo } = await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 1, [userB]);

    await adminSettleMarket(ctx, pdas, new anchor.BN(300_000_000));

    try {
      await sellNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 400_000, 1, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketAlreadySettled");
    }
  });

  it("rejects buy_yes after market settles", async () => {
    const pdas = await createMarket(ctx, "STBY", new anchor.BN(275_000_000), nextFreezeDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const userBYes = getAssociatedTokenAddressSync(pdas.yesMintPda, userB.publicKey);

    await adminSettleMarket(ctx, pdas, new anchor.BN(300_000_000));

    try {
      await buyYes(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, 500_000, 1, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketAlreadySettled");
    }
  });
});

// ─────────────────────────────────────────────────────────────────
//  MULTI-USER SETTLEMENT
// ─────────────────────────────────────────────────────────────────

describe("multi-user settlement", () => {
  let ctx: TestContext;
  let userB: Keypair;
  let userBUsdc: PublicKey;
  let userC: Keypair;
  let userCUsdc: PublicKey;
  let settlementIdx = 1560000000;

  function nextSettlementDate() {
    return new anchor.BN(settlementIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
    const [fundedB, fundedC] = await Promise.all([
      createFundedUser(ctx, 20_000_000),
      createFundedUser(ctx, 20_000_000),
    ]);
    userB = fundedB.user;
    userBUsdc = fundedB.userUsdc;
    userC = fundedC.user;
    userCUsdc = fundedC.userUsdc;
  });

  it("pays only the winning side across two users and drains the vault after all claims", async () => {
    const pdas = await createMarket(ctx, "MSET", new anchor.BN(280_000_000), nextSettlementDate());
    const { userYes: adminYes, userNo: adminNo } = await mintPairForAdmin(ctx, pdas, 2);
    const { userYes: userBYes, userNo: userBNo } = await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 3, [userB]);

    const adminUsdcBefore = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);
    const userBUsdcBefore = Number((await getAccount(ctx.provider.connection, userBUsdc)).amount);

    await adminSettleMarket(ctx, pdas, new anchor.BN(250_000_000));

    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.noMintPda, adminNo, 2);
    await redeemForUser(ctx, pdas, userB.publicKey, userBUsdc, pdas.noMintPda, userBNo, 3, [userB]);
    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, adminYes, 2);
    await redeemForUser(ctx, pdas, userB.publicKey, userBUsdc, pdas.yesMintPda, userBYes, 3, [userB]);

    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const vaultAfter = await tokenAmount(ctx, pdas.vaultPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    const adminYesAfter = await tokenAmount(ctx, adminYes);
    const adminNoAfter = await tokenAmount(ctx, adminNo);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const userBNoAfter = await tokenAmount(ctx, userBNo);

    expectIncrease(adminUsdcBefore, adminUsdcAfter, 2_000_000);
    expectIncrease(userBUsdcBefore, userBUsdcAfter, 3_000_000);
    expect(vaultAfter).to.equal(0);
    expect(market.totalPairsMinted.toNumber()).to.equal(0);
    expect(adminYesAfter).to.equal(0);
    expect(adminNoAfter).to.equal(0);
    expect(userBYesAfter).to.equal(0);
    expect(userBNoAfter).to.equal(0);
  });

  it("drains the vault after redeeming winners and losers held across opposite-side wallets", async () => {
    const pdas = await createMarket(ctx, "MSPL", new anchor.BN(281_000_000), nextSettlementDate());
    const { userYes: adminYes, userNo: adminNo } = await mintPairForAdmin(ctx, pdas, 5);
    const userBYes = await createAssociatedTokenAccount(ctx.provider.connection, userB, pdas.yesMintPda, userB.publicKey);
    const userCNo = await createAssociatedTokenAccount(ctx.provider.connection, userC, pdas.noMintPda, userC.publicKey);

    await transferTokens(ctx, adminYes, userBYes, ctx.admin.publicKey, 2);
    await transferTokens(ctx, adminNo, userCNo, ctx.admin.publicKey, 3);

    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);
    const userCUsdcBefore = await tokenAmount(ctx, userCUsdc);

    await adminSettleMarket(ctx, pdas, new anchor.BN(300_000_000));

    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, adminYes, 3);
    await redeemForUser(ctx, pdas, userB.publicKey, userBUsdc, pdas.yesMintPda, userBYes, 2, [userB]);
    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.noMintPda, adminNo, 2);
    await redeemForUser(ctx, pdas, userC.publicKey, userCUsdc, pdas.noMintPda, userCNo, 3, [userC]);

    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const userCUsdcAfter = await tokenAmount(ctx, userCUsdc);
    const vaultAfter = await tokenAmount(ctx, pdas.vaultPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    const adminYesAfter = await tokenAmount(ctx, adminYes);
    const adminNoAfter = await tokenAmount(ctx, adminNo);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const userCNoAfter = await tokenAmount(ctx, userCNo);

    expectIncrease(adminUsdcBefore, adminUsdcAfter, 3_000_000);
    expectIncrease(userBUsdcBefore, userBUsdcAfter, 2_000_000);
    expect(userCUsdcAfter).to.equal(userCUsdcBefore);
    expect(vaultAfter).to.equal(0);
    expect(market.totalPairsMinted.toNumber()).to.equal(0);
    expect(adminYesAfter).to.equal(0);
    expect(adminNoAfter).to.equal(0);
    expect(userBYesAfter).to.equal(0);
    expect(userCNoAfter).to.equal(0);
  });
});

// ─────────────────────────────────────────────────────────────────
//  SETTLEMENT UNWIND FLOW
// ─────────────────────────────────────────────────────────────────

describe("settlement unwind flow", () => {
  let ctx: TestContext;
  let userB: Keypair;
  let userBUsdc: PublicKey;
  let unwindIdx: number;

  function nextUnwindDate() {
    return new anchor.BN(unwindIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
    unwindIdx = ctx.uniqueTestSeedBase + 10_000;
    const funded = await createFundedUser(ctx, 20_000_000);
    userB = funded.user;
    userBUsdc = funded.userUsdc;
  });

  it("auto-credits resting orders on settlement", async () => {
    const pdas = await createMarket(ctx, "UWBL", new anchor.BN(290_000_000), nextUnwindDate());
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );

    await placeBid(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 1);

    await freezeMarket(ctx, pdas);

    await ctx.methods
      .adminSettle(new anchor.BN(300_000_000))
      .accountsPartial({
        admin: ctx.admin.publicKey,
        config: ctx.configPda,
        market: pdas.marketPda,
      })
      .remainingAccounts(settlementProofAccounts(pdas))
      .rpc();

    const settled = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(settled.outcome).to.not.deep.equal({ none: {} });
  });

  it("allows permissionless unwind during freeze while refunding the order owner", async () => {
    const pdas = await createMarket(ctx, "UWPM", new anchor.BN(290_500_000), nextUnwindDate());
    const { userYes: userBYes } = await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 2, [userB]);

    await placeAsk(ctx, pdas, userB.publicKey, userBUsdc, userBYes, 610_000, 2, { signers: [userB] });

    const yesBeforeFreeze = await tokenAmount(ctx, userBYes);
    const obBefore = await ctx.program.account.orderBook.fetch(pdas.orderBookPda);
    const askOrderId = obBefore.asks[0].orderId;

    expect(yesBeforeFreeze).to.equal(0);

    await freezeMarket(ctx, pdas);

    await unwindOrderForSettlement(ctx, pdas, askOrderId, userBUsdc, userBYes);

    const yesAfterUnwind = await tokenAmount(ctx, userBYes);
    const obYesEscrow = await tokenAmount(ctx, pdas.obYesVault);
    const obAfter = await ctx.program.account.orderBook.fetch(pdas.orderBookPda);

    expect(yesAfterUnwind).to.equal(2);
    expect(obYesEscrow).to.equal(0);
    expect(obAfter.askCount).to.equal(0);

    await settleWithOrderBookProof(ctx, pdas, new anchor.BN(300_000_000));

    const settled = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(settled.outcome).to.deep.equal({ yesWins: {} });
  });

  it("unwind_order conserves ask escrow exactly across vault and refund destination", async () => {
    const pdas = await createMarket(ctx, "UWCV", new anchor.BN(290_750_000), nextUnwindDate());
    const { userYes: userBYes } = await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 2, [userB]);

    await placeAsk(ctx, pdas, userB.publicKey, userBUsdc, userBYes, 620_000, 2, { signers: [userB] });

    const obBefore = await ctx.program.account.orderBook.fetch(pdas.orderBookPda);
    const askOrderId = obBefore.asks[0].orderId;
    const userYesBefore = await tokenAmount(ctx, userBYes);
    const obYesBefore = await tokenAmount(ctx, pdas.obYesVault);

    await freezeMarket(ctx, pdas);
    await unwindOrderForSettlement(ctx, pdas, askOrderId, userBUsdc, userBYes);

    const userYesAfter = await tokenAmount(ctx, userBYes);
    const obYesAfter = await tokenAmount(ctx, pdas.obYesVault);

    expectIncrease(userYesBefore, userYesAfter, 2);
    expectDecrease(obYesBefore, obYesAfter, 2);
    expect(obYesAfter).to.equal(0);
  });

  it("unwinds bid and ask escrow during freeze, then allows settlement", async () => {
    const pdas = await createMarket(ctx, "UWOK", new anchor.BN(291_000_000), nextUnwindDate());
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );
    const { userYes: userBYes } = await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 1, [userB]);

    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBYesBefore = await tokenAmount(ctx, userBYes);

    await placeBid(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 2);
    await placeAsk(ctx, pdas, userB.publicKey, userBUsdc, userBYes, 600_000, 1, { signers: [userB] });

    const obBefore = await ctx.program.account.orderBook.fetch(pdas.orderBookPda);
    const bidOrderId = obBefore.bids[0].orderId;
    const askOrderId = obBefore.asks[0].orderId;

    await freezeMarket(ctx, pdas);

    await unwindOrderForSettlement(ctx, pdas, bidOrderId, ctx.adminUsdcAta, adminYes);
    await unwindOrderForSettlement(ctx, pdas, askOrderId, userBUsdc, userBYes, userB);

    const adminUsdcAfterUnwind = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBYesAfterUnwind = await tokenAmount(ctx, userBYes);
    const obUsdcEscrow = await tokenAmount(ctx, pdas.obUsdcVault);
    const obYesEscrow = await tokenAmount(ctx, pdas.obYesVault);
    const obAfter = await ctx.program.account.orderBook.fetch(pdas.orderBookPda);

    expectIncrease(adminUsdcBefore, adminUsdcAfterUnwind, 0);
    expect(userBYesAfterUnwind).to.equal(userBYesBefore);
    expect(obUsdcEscrow).to.equal(0);
    expect(obYesEscrow).to.equal(0);
    expect(obAfter.bidCount).to.equal(0);
    expect(obAfter.askCount).to.equal(0);

    await settleWithOrderBookProof(ctx, pdas, new anchor.BN(300_000_000));

    const settled = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(settled.outcome).to.deep.equal({ yesWins: {} });
  });

  it("roundtrips create -> freeze -> settle-with-proof -> redeem against config-backed oracle policy", async () => {
    const config = await ctx.program.account.globalConfig.fetch(ctx.configPda);
    const metaPolicy = config.oraclePolicies.find((policy: any) => policy.ticker === "META");
    expect(metaPolicy).to.not.equal(undefined);

    const pdas = await createMarket(ctx, "META", new anchor.BN(292_000_000), nextUnwindDate());
    const { userYes } = await mintPairForAdmin(ctx, pdas, 2);

    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);

    await freezeMarket(ctx, pdas);
    await settleWithOrderBookProof(ctx, pdas, new anchor.BN(300_000_000));
    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, userYes, 2);

    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const vaultAfter = await tokenAmount(ctx, pdas.vaultPda);
    const settled = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    const yesBalanceAfter = await tokenAmount(ctx, userYes);

    expectIncrease(adminUsdcBefore, adminUsdcAfter, 2_000_000);
    expect(vaultAfter).to.equal(0);
    expect(yesBalanceAfter).to.equal(0);
    expect(settled.outcome).to.deep.equal({ yesWins: {} });
    expect(settled.totalPairsMinted.toNumber()).to.equal(0);
  });

  it("cancel orders pre-freeze, unwind remaining post-freeze, settle with empty book", async () => {
    const pdas = await createMarket(ctx, "UWDB", new anchor.BN(293_000_000), nextUnwindDate());
    const { userYes: adminYes, userNo: adminNo } = await mintPairForAdmin(ctx, pdas, 3);
    const { userYes: userBYes, userNo: userBNo } = await mintPairForUser(
      ctx, userB.publicKey, userBUsdc, pdas, 2, [userB]
    );

    // Admin places 2 bids at different prices
    await placeBid(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 400_000, 1);
    await placeBid(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 600_000, 1);

    // UserB places 1 ask
    await placeAsk(ctx, pdas, userB.publicKey, userBUsdc, userBYes, 700_000, 1, { signers: [userB] });

    // Read order IDs
    const obBefore = await ctx.program.account.orderBook.fetch(pdas.orderBookPda);
    const bid1Id = obBefore.bids[0].orderId;
    const bid2Id = obBefore.bids[1].orderId;
    const askId = obBefore.asks[0].orderId;

    // Cancel admin's first bid pre-freeze → refund USDC
    await cancelOrder(ctx, pdas, bid1Id, ctx.admin.publicKey, ctx.adminUsdcAta);

    // Freeze market
    await freezeMarket(ctx, pdas);

    // Cancel fails on frozen market
    try {
      await cancelOrder(ctx, pdas, bid2Id, ctx.admin.publicKey, ctx.adminUsdcAta);
      expect.fail("cancel should fail when frozen");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketFrozen");
    }

    // Unwind admin's second bid → refund USDC
    await unwindOrderForSettlement(ctx, pdas, bid2Id, ctx.adminUsdcAta, adminYes);

    // Unwind userB's ask → refund Yes tokens
    await unwindOrderForSettlement(ctx, pdas, askId, userBUsdc, userBYes);

    // Assert: orderbook drained, escrow vaults empty
    const obAfter = await ctx.program.account.orderBook.fetch(pdas.orderBookPda);
    expect(obAfter.bidCount).to.equal(0);
    expect(obAfter.askCount).to.equal(0);
    expect(await tokenAmount(ctx, pdas.obUsdcVault)).to.equal(0);
    expect(await tokenAmount(ctx, pdas.obYesVault)).to.equal(0);

    // Settle with orderbook proof → succeeds on empty book
    await settleWithOrderBookProof(ctx, pdas, new anchor.BN(300_000_000));

    // Redeem winners (yesWins: price 300M >= strike 293M)
    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, adminYes, 3);
    await redeemForUser(ctx, pdas, userB.publicKey, userBUsdc, pdas.yesMintPda, userBYes, 2, [userB]);

    // Redeem losers (burns No tokens, 0 USDC)
    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.noMintPda, adminNo, 3);
    await redeemForUser(ctx, pdas, userB.publicKey, userBUsdc, pdas.noMintPda, userBNo, 2, [userB]);

    // Assert full invariants: vault=0, supply=0, totalPairsMinted=0
    const vault = await tokenAmount(ctx, pdas.vaultPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(vault).to.equal(0);
    expect(market.totalPairsMinted.toNumber()).to.equal(0);
  });
});

// ─────────────────────────────────────────────────────────────────
//  ORACLE SETTLEMENT (settle_market)
//
//  settle_market reads a Pyth PriceUpdateV2 account on-chain. Full
//  end-to-end testing requires the Pyth Receiver and Wormhole
//  programs cloned onto the test validator. The tests below cover
//  the error paths that DO work in the standard test environment.
//
//  TO ENABLE FULL ORACLE TESTS, add to Anchor.toml:
//    [test.validator]
//    [[test.validator.clone]]
//    address = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"  # Pyth Receiver
//    [[test.validator.clone]]
//    address = "HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ"  # Wormhole Core Bridge
//    url = "https://api.devnet.solana.com"
//  Then replace the stub below with PythSolanaReceiver.buildPostPriceUpdateInstructions
//  + a live VAA from https://hermes-beta.pyth.network at close_time + 30s.
//  The buildMockPriceUpdateV2Data helper in helpers.ts documents the exact
//  PriceUpdateV2 Borsh layout for reference.
// ─────────────────────────────────────────────────────────────────

describe("oracle settlement (settle_market)", () => {
  let ctx: TestContext;
  let oracleIdx = 1590000000;

  function nextOracleDate() {
    return new anchor.BN(oracleIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
  });

  it("rejects settle_market when price_update is owned by the wrong program", async () => {
    // Create a market past its close_time so prepare_for_settlement passes.
    const closedAt = await getCurrentUnixTimestamp(ctx);
    const pdas = await createMarket(
      ctx,
      "NVDA",
      new anchor.BN(300_000_000),
      nextOracleDate(),
      new anchor.BN(closedAt - 10) // close_time 10s ago
    );

    // Create a regular keypair account owned by the System Program.
    // settle_market's Account<'info, PriceUpdateV2> constraint will reject it
    // because the owner is not the Pyth Receiver program.
    const wrongOwnerAccount = Keypair.generate();
    const lamports =
      await ctx.provider.connection.getMinimumBalanceForRentExemption(133);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: ctx.admin.publicKey,
        newAccountPubkey: wrongOwnerAccount.publicKey,
        lamports,
        space: 133,
        programId: SystemProgram.programId, // wrong owner
      })
    );
    await ctx.provider.sendAndConfirm(tx, [ctx.admin.payer, wrongOwnerAccount]);

    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), pdas.marketPda.toBuffer()],
      ctx.program.programId
    );

    try {
      await ctx.methods
        .settleMarket()
        .accountsPartial({
          settler: ctx.admin.publicKey,
          market: pdas.marketPda,
          priceUpdate: wrongOwnerAccount.publicKey,
        })
        .remainingAccounts([
          { pubkey: orderBookPda, isSigner: false, isWritable: true },
        ])
        .rpc();
      expect.fail("Should have thrown AccountOwnedByWrongProgram");
    } catch (err: any) {
      // Anchor rejects accounts not owned by the expected program.
      expect(err.toString()).to.satisfy((msg: string) =>
        msg.includes("AccountOwnedByWrongProgram") ||
        msg.includes("owned by") ||
        msg.includes("OwnerMismatch")
      );
    }
  });

  it("rejects settle_market when price_update has wrong discriminator", async () => {
    // Create a market past its close_time.
    const closedAt = await getCurrentUnixTimestamp(ctx);
    const pdas = await createMarket(
      ctx,
      "NVDA",
      new anchor.BN(300_500_000),
      nextOracleDate(),
      new anchor.BN(closedAt - 10)
    );

    // Create an account owned by the Pyth Receiver program but with all-zero
    // data (no valid discriminator). settle_market should reject with
    // AccountDiscriminatorMismatch.
    const zeroedPriceAccount = Keypair.generate();
    await createEmptyPriceUpdateAccount(ctx, zeroedPriceAccount);

    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), pdas.marketPda.toBuffer()],
      ctx.program.programId
    );

    try {
      await ctx.methods
        .settleMarket()
        .accountsPartial({
          settler: ctx.admin.publicKey,
          market: pdas.marketPda,
          priceUpdate: zeroedPriceAccount.publicKey,
        })
        .remainingAccounts([
          { pubkey: orderBookPda, isSigner: false, isWritable: true },
        ])
        .rpc();
      expect.fail("Should have thrown AccountDiscriminatorMismatch");
    } catch (err: any) {
      expect(err.toString()).to.satisfy((msg: string) =>
        msg.includes("AccountDiscriminatorMismatch") ||
        msg.includes("discriminator") ||
        msg.includes("InvalidAccountData")
      );
    }
  });

  // buildMockPriceUpdateV2Data demonstrates the exact PriceUpdateV2 Borsh
  // layout. Confirm the helper builds a correctly-sized buffer.
  it("buildMockPriceUpdateV2Data produces 133-byte correctly-structured buffer", () => {
    const NVDA_FEED_ID = Array.from(
      Buffer.from(
        "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
        "hex"
      )
    );
    const data = buildMockPriceUpdateV2Data({
      writeAuthority: ctx.admin.publicKey,
      feedId: NVDA_FEED_ID,
      priceDollars: 150.0,
      exponent: -8,
      publishTime: Math.floor(Date.now() / 1000),
    });

    expect(data.length).to.equal(133);

    // Check discriminator bytes
    expect([...data.slice(0, 8)]).to.deep.equal([34, 241, 35, 99, 157, 126, 244, 205]);

    // VerificationLevel::Full = 0x01 at byte 40
    expect(data.readUInt8(40)).to.equal(1);

    // NVDA feed_id starts at byte 41
    expect([...data.slice(41, 73)]).to.deep.equal(NVDA_FEED_ID);
  });

  // TODO(oracle-full-test): Once Anchor.toml includes Pyth Receiver + Wormhole
  // program clones (see header comment), add a test here that:
  //   1. Creates a market with close_time = now - 30
  //   2. Calls PythSolanaReceiver.buildPostPriceUpdateInstructions with a VAA
  //      from hermes-beta.pyth.network at targetTimestamp = close_time + 30
  //   3. Calls settle_market with the resulting PriceUpdateV2 account
  //   4. Asserts market.outcome != Pending and vault empties after redeem
});
