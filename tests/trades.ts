import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  setupTestContext,
  TestContext,
  createMarket,
  initOrderBookForMarket,
  mintPairForAdmin,
  mintPairForUser,
  tokenAccountsFor,
  placeBid,
  placeAsk,
  buyYes,
  sellYes,
  buyNo,
  sellNo,
  claimFills,
  tokenAmount,
  expectIncrease,
  expectDecrease,
  createFundedUser,
} from "./helpers";

describe("trade path scenarios", () => {
  let ctx: TestContext;
  let userB: Keypair;
  let userBUsdc: PublicKey;
  let userC: Keypair;
  let userCUsdc: PublicKey;
  let atomicMarketIdx = 1500000000;

  function nextAtomicDate() {
    return new anchor.BN(atomicMarketIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
    const [fundedB, fundedC] = await Promise.all([
      createFundedUser(ctx, 50_000_000),
      createFundedUser(ctx, 50_000_000),
    ]);
    userB = fundedB.user;
    userBUsdc = fundedB.userUsdc;
    userC = fundedC.user;
    userCUsdc = fundedC.userUsdc;
  });

  it("buy yes: a crossing bid acquires Yes from a resting ask", async () => {
    const pdas = await createMarket(ctx, "BYES", new anchor.BN(245_000_000), nextAtomicDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey);
    const userBYes = getAssociatedTokenAddressSync(pdas.yesMintPda, userB.publicKey);

    await mintPairForAdmin(ctx, pdas, 1);

    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);

    await placeAsk(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 450_000, 1);
    await buyYes(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, 500_000, 1, { signers: [userB] });
    await claimFills(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes);

    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const obAfter = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    expectIncrease(adminUsdcBefore, adminUsdcAfter, 450_000);
    expectDecrease(userBUsdcBefore, userBUsdcAfter, 450_000);
    expect(userBYesAfter).to.equal(1);
    expect(obAfter.bidCount).to.equal(0);
    expect(obAfter.askCount).to.equal(0);
  });

  it("sell yes: a crossing ask sells Yes into a resting bid", async () => {
    const pdas = await createMarket(ctx, "SYES", new anchor.BN(246_000_000), nextAtomicDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const { userYes: userBYes } = await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 1, [userB]);
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );

    const adminYesBefore = await tokenAmount(ctx, adminYes);
    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);

    await placeBid(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 550_000, 1);
    await sellYes(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, 500_000, 1, { signers: [userB] });
    await claimFills(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes);

    const adminYesAfter = await tokenAmount(ctx, adminYes);
    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const obAfter = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    expectIncrease(adminYesBefore, adminYesAfter, 1);
    expectIncrease(userBUsdcBefore, userBUsdcAfter, 550_000);
    expect(userBYesAfter).to.equal(0);
    expect(obAfter.bidCount).to.equal(0);
    expect(obAfter.askCount).to.equal(0);
  });

  it("buy no: mints a pair, sells Yes into resting bids, and leaves the user long No", async () => {
    const pdas = await createMarket(ctx, "ABNO", new anchor.BN(250_000_000), nextAtomicDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );
    const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);

    await placeBid(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 650_000, 1);

    await buyNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 600_000, 1, { signers: [userB] });
    await claimFills(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes);

    const adminYesAfter = await tokenAmount(ctx, adminYes);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const userBNoAfter = await tokenAmount(ctx, userBNo);
    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const vaultAfter = await tokenAmount(ctx, pdas.vaultPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    const orderBook = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    expect(adminYesAfter).to.equal(1);
    expect(userBYesAfter).to.equal(0);
    expect(userBNoAfter).to.equal(1);
    expectDecrease(adminUsdcBefore, adminUsdcAfter, 650_000);
    expectDecrease(userBUsdcBefore, userBUsdcAfter, 350_000);
    expect(vaultAfter).to.equal(1_000_000);
    expect(market.totalPairsMinted.toNumber()).to.equal(1);
    expect(orderBook.bidCount).to.equal(0);
    expect(orderBook.askCount).to.equal(0);
  });

  it("buy no: partially fills across multiple bids and leaves the residual bid on book", async () => {
    const pdas = await createMarket(ctx, "ABNP", new anchor.BN(251_000_000), nextAtomicDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );
    const userCYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      userC,
      pdas.yesMintPda,
      userC.publicKey
    );
    const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userCUsdcBefore = await tokenAmount(ctx, userCUsdc);
    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);

    await placeBid(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 650_000, 1);
    await placeBid(ctx, { ...pdas, ...obPdas }, userC.publicKey, userCUsdc, userCYes, 640_000, 2, { signers: [userC] });

    await buyNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 600_000, 2, { signers: [userB] });
    await claimFills(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes);
    await claimFills(ctx, { ...pdas, ...obPdas }, userC.publicKey, userCUsdc, userCYes);

    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userCUsdcAfter = await tokenAmount(ctx, userCUsdc);
    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const adminYesAfter = await tokenAmount(ctx, adminYes);
    const userCYesAfter = await tokenAmount(ctx, userCYes);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const userBNoAfter = await tokenAmount(ctx, userBNo);
    const yesMint = await getMint(ctx.provider.connection, pdas.yesMintPda);
    const noMint = await getMint(ctx.provider.connection, pdas.noMintPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    const orderBook = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    expectDecrease(adminUsdcBefore, adminUsdcAfter, 650_000);
    // userC escrowed 2 bids * 640k = 1,280k; only 1 filled (got Yes via claim), 1 still resting
    expectDecrease(userCUsdcBefore, userCUsdcAfter, 1_280_000);
    expectDecrease(userBUsdcBefore, userBUsdcAfter, 710_000);
    expect(adminYesAfter).to.equal(1);
    expect(userCYesAfter).to.equal(1);
    expect(userBYesAfter).to.equal(0);
    expect(userBNoAfter).to.equal(2);
    expect(Number(yesMint.supply)).to.equal(2);
    expect(Number(noMint.supply)).to.equal(2);
    expect(market.totalPairsMinted.toNumber()).to.equal(2);
    expect(orderBook.bidCount).to.equal(1);
    expect(orderBook.askCount).to.equal(0);
    expect(orderBook.bids[0].owner.toBase58()).to.equal(userC.publicKey.toBase58());
    expect(orderBook.bids[0].price.toNumber()).to.equal(640_000);
    expect(orderBook.bids[0].quantity.toNumber()).to.equal(1);
  });

  it("sell no: buys Yes from resting asks, burns the pair, and returns USDC collateral", async () => {
    const pdas = await createMarket(ctx, "ASNO", new anchor.BN(260_000_000), nextAtomicDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey);
    const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

    await mintPairForAdmin(ctx, { ...pdas, ...obPdas }, 2);
    await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 2, [userB]);

    await placeAsk(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 400_000, 2);

    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);

    await sellNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 400_000, 2, { signers: [userB] });
    await claimFills(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes);

    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const userBNoAfter = await tokenAmount(ctx, userBNo);
    const vaultAfter = await tokenAmount(ctx, pdas.vaultPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    const orderBook = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    expectIncrease(adminUsdcBefore, adminUsdcAfter, 800_000);
    expectIncrease(userBUsdcBefore, userBUsdcAfter, 1_200_000);
    expect(userBYesAfter).to.equal(2);
    expect(userBNoAfter).to.equal(0);
    expect(vaultAfter).to.equal(2_000_000);
    expect(market.totalPairsMinted.toNumber()).to.equal(2);
    expect(orderBook.bidCount).to.equal(0);
    expect(orderBook.askCount).to.equal(0);
  });

  it("sell no: partially fills across multiple asks and leaves the residual ask on book", async () => {
    const pdas = await createMarket(ctx, "ASNP", new anchor.BN(261_000_000), nextAtomicDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey);
    const { userYes: userCYes } = await mintPairForUser(ctx, userC.publicKey, userCUsdc, pdas, 2, [userC]);
    const { userYes: userBYes, userNo: userBNo } = await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 2, [userB]);

    await mintPairForAdmin(ctx, { ...pdas, ...obPdas }, 1);

    await placeAsk(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 300_000, 1);
    await placeAsk(ctx, { ...pdas, ...obPdas }, userC.publicKey, userCUsdc, userCYes, 350_000, 2, { signers: [userC] });

    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userCUsdcBefore = await tokenAmount(ctx, userCUsdc);
    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);

    await sellNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 400_000, 2, { signers: [userB] });
    await claimFills(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes);
    await claimFills(ctx, { ...pdas, ...obPdas }, userC.publicKey, userCUsdc, userCYes);

    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    const userCUsdcAfter = await tokenAmount(ctx, userCUsdc);
    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const userBNoAfter = await tokenAmount(ctx, userBNo);
    const vaultAfter = await tokenAmount(ctx, pdas.vaultPda);
    const yesMint = await getMint(ctx.provider.connection, pdas.yesMintPda);
    const noMint = await getMint(ctx.provider.connection, pdas.noMintPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    const orderBook = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    expectIncrease(adminUsdcBefore, adminUsdcAfter, 300_000);
    expectIncrease(userCUsdcBefore, userCUsdcAfter, 350_000);
    expectIncrease(userBUsdcBefore, userBUsdcAfter, 1_350_000);
    expect(userBYesAfter).to.equal(2);
    expect(userBNoAfter).to.equal(0);
    expect(vaultAfter).to.equal(3_000_000);
    expect(Number(yesMint.supply)).to.equal(3);
    expect(Number(noMint.supply)).to.equal(3);
    expect(market.totalPairsMinted.toNumber()).to.equal(3);
    expect(orderBook.bidCount).to.equal(0);
    expect(orderBook.askCount).to.equal(1);
    expect(orderBook.asks[0].owner.toBase58()).to.equal(userC.publicKey.toBase58());
    expect(orderBook.asks[0].price.toNumber()).to.equal(350_000);
    expect(orderBook.asks[0].quantity.toNumber()).to.equal(1);
  });

  it("buy no: incomplete atomic fill leaves user balances and vaults unchanged", async () => {
    const pdas = await createMarket(ctx, "ABNF", new anchor.BN(252_000_000), nextAtomicDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );
    const userBYes = await createAssociatedTokenAccount(ctx.provider.connection, userB, pdas.yesMintPda, userB.publicKey);
    const userBNo = await createAssociatedTokenAccount(ctx.provider.connection, userB, pdas.noMintPda, userB.publicKey);

    await placeBid(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 650_000, 1);

    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);
    const userBYesBefore = await tokenAmount(ctx, userBYes);
    const userBNoBefore = await tokenAmount(ctx, userBNo);
    const marketVaultBefore = await tokenAmount(ctx, pdas.vaultPda);
    const obUsdcBefore = await tokenAmount(ctx, obPdas.obUsdcVault);
    const obYesBefore = await tokenAmount(ctx, obPdas.obYesVault);
    const orderBookBefore = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    try {
      await buyNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 600_000, 2, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("AtomicTradeIncomplete");
    }

    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const userBNoAfter = await tokenAmount(ctx, userBNo);
    const marketVaultAfter = await tokenAmount(ctx, pdas.vaultPda);
    const obUsdcAfter = await tokenAmount(ctx, obPdas.obUsdcVault);
    const obYesAfter = await tokenAmount(ctx, obPdas.obYesVault);
    const orderBookAfter = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    expect(userBUsdcAfter).to.equal(userBUsdcBefore);
    expect(userBYesAfter).to.equal(userBYesBefore);
    expect(userBNoAfter).to.equal(userBNoBefore);
    expect(marketVaultAfter).to.equal(marketVaultBefore);
    expect(obUsdcAfter).to.equal(obUsdcBefore);
    expect(obYesAfter).to.equal(obYesBefore);
    expect(orderBookAfter.bidCount).to.equal(orderBookBefore.bidCount);
    expect(orderBookAfter.bids[0].quantity.toNumber()).to.equal(orderBookBefore.bids[0].quantity.toNumber());
  });

  it("sell no: incomplete atomic fill leaves user balances and vaults unchanged", async () => {
    const pdas = await createMarket(ctx, "ASNF", new anchor.BN(262_000_000), nextAtomicDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey);
    const { userYes: userBYes, userNo: userBNo } = await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 2, [userB]);

    await mintPairForAdmin(ctx, { ...pdas, ...obPdas }, 1);
    await placeAsk(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 400_000, 1);

    const userBUsdcBefore = await tokenAmount(ctx, userBUsdc);
    const userBYesBefore = await tokenAmount(ctx, userBYes);
    const userBNoBefore = await tokenAmount(ctx, userBNo);
    const marketVaultBefore = await tokenAmount(ctx, pdas.vaultPda);
    const obUsdcBefore = await tokenAmount(ctx, obPdas.obUsdcVault);
    const obYesBefore = await tokenAmount(ctx, obPdas.obYesVault);
    const orderBookBefore = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    try {
      await sellNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 400_000, 2, { signers: [userB] });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("AtomicTradeIncomplete");
    }

    const userBUsdcAfter = await tokenAmount(ctx, userBUsdc);
    const userBYesAfter = await tokenAmount(ctx, userBYes);
    const userBNoAfter = await tokenAmount(ctx, userBNo);
    const marketVaultAfter = await tokenAmount(ctx, pdas.vaultPda);
    const obUsdcAfter = await tokenAmount(ctx, obPdas.obUsdcVault);
    const obYesAfter = await tokenAmount(ctx, obPdas.obYesVault);
    const orderBookAfter = await ctx.program.account.orderBook.fetch(obPdas.orderBookPda);

    expect(userBUsdcAfter).to.equal(userBUsdcBefore);
    expect(userBYesAfter).to.equal(userBYesBefore);
    expect(userBNoAfter).to.equal(userBNoBefore);
    expect(marketVaultAfter).to.equal(marketVaultBefore);
    expect(obUsdcAfter).to.equal(obUsdcBefore);
    expect(obYesAfter).to.equal(obYesBefore);
    expect(orderBookAfter.askCount).to.equal(orderBookBefore.askCount);
    expect(orderBookAfter.asks[0].quantity.toNumber()).to.equal(orderBookBefore.asks[0].quantity.toNumber());
  });
});
