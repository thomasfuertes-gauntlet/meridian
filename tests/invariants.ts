import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from "@solana/spl-token";
import {
  setupTestContext,
  TestContext,
  createMarket,
  initOrderBookForMarket,
  mintPairForAdmin,
  mintPairForUser,
  burnPairForUser,
  tokenAccountsFor,
  userTokenAccounts,
  placeBid,
  placeAsk,
  buyYes,
  buyNo,
  sellNo,
  adminSettleMarket,
  redeemForUser,
  tokenAmount,
  expectIncrease,
  createFundedUser,
  transferTokens,
  pauseProtocol,
  unpauseProtocol,
  freezeMarket,
  unwindOrderForSettlement,
  settleWithOrderBookProof,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────
//  VAULT INVARIANTS
// ─────────────────────────────────────────────────────────────────

describe("vault invariants", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestContext();
  });

  it("after multiple mints: vault == totalPairsMinted * 1_000_000", async () => {
    const pdas = await createMarket(ctx, "IVLT", new anchor.BN(222_000_000), new anchor.BN(1600000010));

    for (let i = 0; i < 7; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    const vault = await getAccount(ctx.provider.connection, pdas.vaultPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(Number(vault.amount)).to.equal(market.totalPairsMinted.toNumber() * 1_000_000);
    expect(market.totalPairsMinted.toNumber()).to.equal(7);
  });

  it("after mint then burn: vault == totalPairsMinted * 1_000_000", async () => {
    const pdas = await createMarket(ctx, "IVBU", new anchor.BN(223_000_000), new anchor.BN(1600000011));

    for (let i = 0; i < 5; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    await burnPairForUser(ctx, ctx.admin.publicKey, ctx.adminUsdcAta, pdas, 2);

    const vault = await getAccount(ctx.provider.connection, pdas.vaultPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(market.totalPairsMinted.toNumber()).to.equal(3);
    expect(Number(vault.amount)).to.equal(3 * 1_000_000);
  });

  it("after mint, settle, redeem winner: vault == (total - redeemed) * 1_000_000", async () => {
    const pdas = await createMarket(ctx, "IVRD", new anchor.BN(224_000_000), new anchor.BN(1600000012));
    const { userYes } = userTokenAccounts(ctx, pdas);

    for (let i = 0; i < 6; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    await adminSettleMarket(ctx, pdas, new anchor.BN(224_000_000));

    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, userYes, 4);

    const vault = await getAccount(ctx.provider.connection, pdas.vaultPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(market.totalPairsMinted.toNumber()).to.equal(2);
    expect(Number(vault.amount)).to.equal(2 * 1_000_000);
  });

  it("full lifecycle (mint 10, burn 3, settle, redeem 7 winners): vault empty", async () => {
    const pdas = await createMarket(ctx, "IVFL", new anchor.BN(225_000_000), new anchor.BN(1600000013));
    const { userYes, userNo } = userTokenAccounts(ctx, pdas);

    for (let i = 0; i < 10; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    await burnPairForUser(ctx, ctx.admin.publicKey, ctx.adminUsdcAta, pdas, 3);

    await adminSettleMarket(ctx, pdas, new anchor.BN(200_000_000));

    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.noMintPda, userNo, 7);
    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, userYes, 7);

    const vault = await getAccount(ctx.provider.connection, pdas.vaultPda);
    expect(Number(vault.amount)).to.equal(0);

    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(market.totalPairsMinted.toNumber()).to.equal(0);
  });

  it("repeated partial winner claims decrease vault, supply, and open interest in lockstep", async () => {
    const pdas = await createMarket(ctx, "IVPM", new anchor.BN(226_000_000), new anchor.BN(1600000014));
    const { userYes, userNo } = userTokenAccounts(ctx, pdas);

    await mintPairForAdmin(ctx, pdas, 5);
    await adminSettleMarket(ctx, pdas, new anchor.BN(226_000_000));

    const winnerRedeems = [1, 2, 2];
    let redeemedWinners = 0;

    for (const amount of winnerRedeems) {
      await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, userYes, amount);
      redeemedWinners += amount;

      const vault = await getAccount(ctx.provider.connection, pdas.vaultPda);
      const yesMint = await getMint(ctx.provider.connection, pdas.yesMintPda);
      const noMint = await getMint(ctx.provider.connection, pdas.noMintPda);
      const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
      const remainingClaims = 5 - redeemedWinners;

      expect(Number(vault.amount)).to.equal(remainingClaims * 1_000_000);
      expect(Number(yesMint.supply)).to.equal(remainingClaims);
      expect(Number(noMint.supply)).to.equal(5);
      expect(market.totalPairsMinted.toNumber()).to.equal(remainingClaims);
    }

    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.noMintPda, userNo, 5);

    const finalVault = await getAccount(ctx.provider.connection, pdas.vaultPda);
    const finalYesMint = await getMint(ctx.provider.connection, pdas.yesMintPda);
    const finalNoMint = await getMint(ctx.provider.connection, pdas.noMintPda);
    const finalMarket = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);

    expect(Number(finalVault.amount)).to.equal(0);
    expect(Number(finalYesMint.supply)).to.equal(0);
    expect(Number(finalNoMint.supply)).to.equal(0);
    expect(finalMarket.totalPairsMinted.toNumber()).to.equal(0);
  });
});

// ─────────────────────────────────────────────────────────────────
//  TOKEN SUPPLY INVARIANTS
// ─────────────────────────────────────────────────────────────────

describe("token supply invariants", () => {
  let ctx: TestContext;
  let userB: Keypair;
  let userBUsdc: PublicKey;
  let supplyMarketIdx = 1600000022;

  function nextSupplyDate() {
    return new anchor.BN(supplyMarketIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
    const funded = await createFundedUser(ctx, 20_000_000);
    userB = funded.user;
    userBUsdc = funded.userUsdc;
  });

  it("after mint: yes_supply == no_supply == totalPairsMinted", async () => {
    const pdas = await createMarket(ctx, "ISUP", new anchor.BN(230_000_000), new anchor.BN(1600000020));

    for (let i = 0; i < 4; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    const yesMint = await getMint(ctx.provider.connection, pdas.yesMintPda);
    const noMint = await getMint(ctx.provider.connection, pdas.noMintPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);

    expect(Number(yesMint.supply)).to.equal(4);
    expect(Number(noMint.supply)).to.equal(4);
    expect(Number(yesMint.supply)).to.equal(Number(noMint.supply));
    expect(Number(yesMint.supply)).to.equal(market.totalPairsMinted.toNumber());
  });

  it("after burn: yes_supply == no_supply (still equal)", async () => {
    const pdas = await createMarket(ctx, "ISUB", new anchor.BN(231_000_000), new anchor.BN(1600000021));

    for (let i = 0; i < 6; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    await burnPairForUser(ctx, ctx.admin.publicKey, ctx.adminUsdcAta, pdas, 2);

    const yesMint = await getMint(ctx.provider.connection, pdas.yesMintPda);
    const noMint = await getMint(ctx.provider.connection, pdas.noMintPda);

    expect(Number(yesMint.supply)).to.equal(4);
    expect(Number(noMint.supply)).to.equal(4);
    expect(Number(yesMint.supply)).to.equal(Number(noMint.supply));
  });

  it("after atomic buy-no composition: unsettled yes_supply == no_supply == totalPairsMinted", async () => {
    const pdas = await createMarket(ctx, "ISBN", new anchor.BN(232_000_000), nextSupplyDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );
    const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

    await placeBid(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 650_000, 1);

    await buyNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 600_000, 1, { signers: [userB] });

    const yesMint = await getMint(ctx.provider.connection, pdas.yesMintPda);
    const noMint = await getMint(ctx.provider.connection, pdas.noMintPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);

    expect(Number(yesMint.supply)).to.equal(1);
    expect(Number(noMint.supply)).to.equal(1);
    expect(Number(yesMint.supply)).to.equal(Number(noMint.supply));
    expect(Number(yesMint.supply)).to.equal(market.totalPairsMinted.toNumber());
  });

  it("after atomic sell-no composition: unsettled yes_supply == no_supply == totalPairsMinted", async () => {
    const pdas = await createMarket(ctx, "ISSN", new anchor.BN(233_000_000), nextSupplyDate());
    const obPdas = await initOrderBookForMarket(ctx, pdas.marketPda, pdas.yesMintPda);
    const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, ctx.admin.publicKey);
    const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

    await mintPairForAdmin(ctx, { ...pdas, ...obPdas }, 2);
    await mintPairForUser(ctx, userB.publicKey, userBUsdc, pdas, 2, [userB]);

    await placeAsk(ctx, { ...pdas, ...obPdas }, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 400_000, 2);

    await sellNo(ctx, { ...pdas, ...obPdas }, userB.publicKey, userBUsdc, userBYes, userBNo, 400_000, 2, { signers: [userB] });

    const yesMint = await getMint(ctx.provider.connection, pdas.yesMintPda);
    const noMint = await getMint(ctx.provider.connection, pdas.noMintPda);
    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);

    expect(Number(yesMint.supply)).to.equal(2);
    expect(Number(noMint.supply)).to.equal(2);
    expect(Number(yesMint.supply)).to.equal(Number(noMint.supply));
    expect(Number(yesMint.supply)).to.equal(market.totalPairsMinted.toNumber());
  });
});

// ─────────────────────────────────────────────────────────────────
//  MULTI-MARKET ISOLATION INVARIANTS
// ─────────────────────────────────────────────────────────────────

describe("multi-market isolation invariants", () => {
  let ctx: TestContext;
  let userB: Keypair;
  let userBUsdc: PublicKey;
  let multiMarketIdx = 1600000100;

  function nextMultiMarketDate() {
    return new anchor.BN(multiMarketIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
    const funded = await createFundedUser(ctx, 20_000_000);
    userB = funded.user;
    userBUsdc = funded.userUsdc;
  });

  it("keeps vaults, supplies, and order books isolated across concurrent market activity", async () => {
    const marketA = await createMarket(ctx, "AAPL", new anchor.BN(236_000_000), nextMultiMarketDate());
    const marketB = await createMarket(ctx, "MSFT", new anchor.BN(237_000_000), nextMultiMarketDate());
    const marketC = await createMarket(ctx, "META", new anchor.BN(238_000_000), nextMultiMarketDate());

    await mintPairForAdmin(ctx, marketA, 3);
    const { userYes: userBYesB } = await mintPairForUser(ctx, userB.publicKey, userBUsdc, marketB, 2, [userB]);
    const { userYes: adminYesC } = await mintPairForAdmin(ctx, marketC, 1);

    await burnPairForUser(ctx, ctx.admin.publicKey, ctx.adminUsdcAta, marketA, 1);
    await adminSettleMarket(ctx, marketB, new anchor.BN(300_000_000));
    await redeemForUser(ctx, marketB, userB.publicKey, userBUsdc, marketB.yesMintPda, userBYesB, 1, [userB]);
    await placeBid(ctx, marketC, ctx.admin.publicKey, ctx.adminUsdcAta, adminYesC, 500_000, 1);

    const marketAState = await ctx.program.account.strikeMarket.fetch(marketA.marketPda);
    const marketBState = await ctx.program.account.strikeMarket.fetch(marketB.marketPda);
    const marketCState = await ctx.program.account.strikeMarket.fetch(marketC.marketPda);
    const marketAVault = await tokenAmount(ctx, marketA.vaultPda);
    const marketBVault = await tokenAmount(ctx, marketB.vaultPda);
    const marketCVault = await tokenAmount(ctx, marketC.vaultPda);
    const marketCBook = await ctx.program.account.orderBook.fetch(marketC.orderBookPda);
    const marketCObUsdc = await tokenAmount(ctx, marketC.obUsdcVault);
    const marketAYesMint = await getMint(ctx.provider.connection, marketA.yesMintPda);
    const marketANoMint = await getMint(ctx.provider.connection, marketA.noMintPda);
    const marketBYesMint = await getMint(ctx.provider.connection, marketB.yesMintPda);
    const marketBNoMint = await getMint(ctx.provider.connection, marketB.noMintPda);
    const marketCYesMint = await getMint(ctx.provider.connection, marketC.yesMintPda);
    const marketCNoMint = await getMint(ctx.provider.connection, marketC.noMintPda);

    expect(marketAState.outcome).to.deep.equal({ pending: {} });
    expect(marketAState.totalPairsMinted.toNumber()).to.equal(2);
    expect(marketAVault).to.equal(2_000_000);
    expect(Number(marketAYesMint.supply)).to.equal(2);
    expect(Number(marketANoMint.supply)).to.equal(2);

    expect(marketBState.outcome).to.deep.equal({ yesWins: {} });
    expect(marketBState.totalPairsMinted.toNumber()).to.equal(1);
    expect(marketBVault).to.equal(1_000_000);
    expect(Number(marketBYesMint.supply)).to.equal(1);
    // Post-settlement redeem only burns the winning token (Yes); No supply unchanged
    expect(Number(marketBNoMint.supply)).to.equal(2);

    expect(marketCState.outcome).to.deep.equal({ pending: {} });
    expect(marketCState.totalPairsMinted.toNumber()).to.equal(1);
    expect(marketCVault).to.equal(1_000_000);
    expect(Number(marketCYesMint.supply)).to.equal(1);
    expect(Number(marketCNoMint.supply)).to.equal(1);
    expect(marketCBook.bidCount).to.equal(1);
    expect(marketCBook.askCount).to.equal(0);
    expect(marketCObUsdc).to.equal(500_000);
  });
});

// ─────────────────────────────────────────────────────────────────
//  SETTLEMENT IMMUTABILITY
// ─────────────────────────────────────────────────────────────────

describe("settlement immutability", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestContext();
  });

  it("re-settling raises MarketAlreadySettled", async () => {
    const pdas = await createMarket(ctx, "ISIM", new anchor.BN(240_000_000), new anchor.BN(1600000030));

    await adminSettleMarket(ctx, pdas, new anchor.BN(250_000_000));

    try {
      await ctx.program.methods
        .adminSettle(new anchor.BN(200_000_000))
        .accountsPartial({
          admin: ctx.admin.publicKey,
          config: ctx.configPda,
          market: pdas.marketPda,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketAlreadySettled");
    }
  });

  it("outcome does not change on re-fetch after settlement", async () => {
    const pdas = await createMarket(ctx, "ISRF", new anchor.BN(241_000_000), new anchor.BN(1600000031));

    await adminSettleMarket(ctx, pdas, new anchor.BN(300_000_000));

    const market1 = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(market1.outcome).to.deep.equal({ yesWins: {} });

    const market2 = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(market2.outcome).to.deep.equal({ yesWins: {} });
    expect(market2.settledAt.toNumber()).to.equal(market1.settledAt.toNumber());
  });
});

// ─────────────────────────────────────────────────────────────────
//  EDGE CASES
// ─────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestContext();
  });

  it("oracle at exactly strike price -> YesWins (at-or-above rule)", async () => {
    const strikePrice = new anchor.BN(333_000_000);
    const pdas = await createMarket(ctx, "EEXA", strikePrice, new anchor.BN(1600000040));

    await adminSettleMarket(ctx, pdas, new anchor.BN(333_000_000));

    const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(market.outcome).to.deep.equal({ yesWins: {} });
  });

  it("redeem losing tokens: burns tokens, user gets 0 USDC, vault unchanged", async () => {
    const pdas = await createMarket(ctx, "ELOSE", new anchor.BN(334_000_000), new anchor.BN(1600000041));
    const { userNo } = userTokenAccounts(ctx, pdas);

    for (let i = 0; i < 3; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    await adminSettleMarket(ctx, pdas, new anchor.BN(400_000_000));

    const vaultBefore = Number((await getAccount(ctx.provider.connection, pdas.vaultPda)).amount);
    const usdcBefore = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);

    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.noMintPda, userNo, 3);

    const vaultAfter = Number((await getAccount(ctx.provider.connection, pdas.vaultPda)).amount);
    const usdcAfter = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);

    expect(vaultAfter).to.equal(vaultBefore);
    expect(usdcAfter).to.equal(usdcBefore);

    const noBalance = Number((await getAccount(ctx.provider.connection, userNo)).amount);
    expect(noBalance).to.equal(0);
  });

  it("pre-settlement complete-set redeem returns exactly 1 USDC per pair", async () => {
    const pdas = await createMarket(ctx, "EBRN", new anchor.BN(335_000_000), new anchor.BN(1600000042));

    for (let i = 0; i < 5; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    const usdcBefore = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);

    await burnPairForUser(ctx, ctx.admin.publicKey, ctx.adminUsdcAta, pdas, 3);

    const usdcAfter = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);
    expect(usdcAfter - usdcBefore).to.equal(3 * 1_000_000);
  });
});

// ─────────────────────────────────────────────────────────────────
//  PAUSED-PROTOCOL INVARIANTS
// ─────────────────────────────────────────────────────────────────

describe("paused-protocol invariants", () => {
  let ctx: TestContext;
  let pauseMarketIdx = 1600000200;

  function nextPauseDate() {
    return new anchor.BN(pauseMarketIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
  });

  it("vault and supply invariants hold when operations are rejected during pause", async () => {
    const pdas = await createMarket(ctx, "AAPL", new anchor.BN(250_000_000), nextPauseDate());
    const { userYes: adminYes } = await mintPairForAdmin(ctx, pdas, 5);

    const vaultBefore = await tokenAmount(ctx, pdas.vaultPda);
    const yesMintBefore = await getMint(ctx.provider.connection, pdas.yesMintPda);
    const noMintBefore = await getMint(ctx.provider.connection, pdas.noMintPda);
    const marketBefore = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);

    await pauseProtocol(ctx);

    try {
      // Attempt mint - should fail with Paused
      try {
        await mintPairForAdmin(ctx, pdas, 1);
        expect.fail("mint should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Paused");
      }

      // Attempt placeOrder - should fail with Paused
      try {
        await placeBid(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 1);
        expect.fail("placeOrder should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Paused");
      }

      // Attempt buyYes - should fail with Paused
      try {
        await buyYes(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, adminYes, 500_000, 1);
        expect.fail("buyYes should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Paused");
      }

      // Assert invariants unchanged
      const vaultAfter = await tokenAmount(ctx, pdas.vaultPda);
      const yesMintAfter = await getMint(ctx.provider.connection, pdas.yesMintPda);
      const noMintAfter = await getMint(ctx.provider.connection, pdas.noMintPda);
      const marketAfter = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);

      expect(vaultAfter).to.equal(vaultBefore);
      expect(Number(yesMintAfter.supply)).to.equal(Number(yesMintBefore.supply));
      expect(Number(noMintAfter.supply)).to.equal(Number(noMintBefore.supply));
      expect(marketAfter.totalPairsMinted.toNumber()).to.equal(marketBefore.totalPairsMinted.toNumber());
    } finally {
      await unpauseProtocol(ctx);
    }

    // After unpause, mint 1 more pair succeeds and invariants hold
    await mintPairForAdmin(ctx, pdas, 1);

    const vaultFinal = await tokenAmount(ctx, pdas.vaultPda);
    const marketFinal = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(vaultFinal).to.equal(6_000_000);
    expect(marketFinal.totalPairsMinted.toNumber()).to.equal(6);
  });

  it("settlement and redeem succeed while paused, preserving invariants", async () => {
    const pdas = await createMarket(ctx, "MSFT", new anchor.BN(251_000_000), nextPauseDate());
    const { userYes: adminYes } = await mintPairForAdmin(ctx, pdas, 3);

    await pauseProtocol(ctx);

    try {
      // Settlement should succeed while paused (not pause-aware)
      await adminSettleMarket(ctx, pdas, new anchor.BN(251_000_000));

      // Redeem winners should succeed while paused
      await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, adminYes, 2);

      const vault = await tokenAmount(ctx, pdas.vaultPda);
      const market = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
      const yesMint = await getMint(ctx.provider.connection, pdas.yesMintPda);

      expect(vault).to.equal(1_000_000);
      expect(market.totalPairsMinted.toNumber()).to.equal(1);
      expect(Number(yesMint.supply)).to.equal(1);
    } finally {
      await unpauseProtocol(ctx);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
//  CROSS-MARKET ISOLATION WITH PARALLEL OPERATIONS
// ─────────────────────────────────────────────────────────────────

describe("cross-market isolation with parallel operations", () => {
  let ctx: TestContext;
  let isoMarketIdx = 1600000300;

  function nextIsoDate() {
    return new anchor.BN(isoMarketIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
  });

  it("settle market A while B has open orders and C is being unwound", async () => {
    // Create 3 markets on different tickers
    const marketA = await createMarket(ctx, "AAPL", new anchor.BN(260_000_000), nextIsoDate());
    const marketB = await createMarket(ctx, "NVDA", new anchor.BN(261_000_000), nextIsoDate());
    const marketC = await createMarket(ctx, "TSLA", new anchor.BN(262_000_000), nextIsoDate());

    // Derive admin ATAs for each market's Yes mint
    const adminYesA = getAssociatedTokenAddressSync(marketA.yesMintPda, ctx.admin.publicKey);
    const adminYesB = getAssociatedTokenAddressSync(marketB.yesMintPda, ctx.admin.publicKey);
    const adminYesC = getAssociatedTokenAddressSync(marketC.yesMintPda, ctx.admin.publicKey);

    // Market A: mint 3 pairs, place a bid
    await mintPairForAdmin(ctx, marketA, 3);
    await placeBid(ctx, marketA, ctx.admin.publicKey, ctx.adminUsdcAta, adminYesA, 500_000, 1);

    // Market B: mint 2 pairs, place bid + ask (active CLOB)
    await mintPairForAdmin(ctx, marketB, 2);
    await placeBid(ctx, marketB, ctx.admin.publicKey, ctx.adminUsdcAta, adminYesB, 400_000, 1);
    await placeAsk(ctx, marketB, ctx.admin.publicKey, ctx.adminUsdcAta, adminYesB, 700_000, 1);

    // Market C: mint 2 pairs, place ask
    await mintPairForAdmin(ctx, marketC, 2);
    await placeAsk(ctx, marketC, ctx.admin.publicKey, ctx.adminUsdcAta, adminYesC, 600_000, 1);

    // Freeze market C
    await freezeMarket(ctx, marketC);

    // Read market C's ask order ID before unwind
    const obC = await ctx.program.account.orderBook.fetch(marketC.orderBookPda);
    const askOrderIdC = obC.asks[0].orderId;

    // Settle market A (freeze + admin_settle with orderbook proof)
    await adminSettleMarket(ctx, marketA, new anchor.BN(260_000_000));

    // Unwind market C's ask
    await unwindOrderForSettlement(ctx, marketC, askOrderIdC, ctx.adminUsdcAta, adminYesC);

    // ── Assert Market A: settled (yesWins), vault intact ──
    const marketAState = await ctx.program.account.strikeMarket.fetch(marketA.marketPda);
    const marketAVault = await tokenAmount(ctx, marketA.vaultPda);
    expect(marketAState.outcome).to.deep.equal({ yesWins: {} });
    expect(marketAVault).to.equal(3_000_000);

    // ── Assert Market B: still active, vault + CLOB escrow intact ──
    const marketBState = await ctx.program.account.strikeMarket.fetch(marketB.marketPda);
    const marketBVault = await tokenAmount(ctx, marketB.vaultPda);
    const marketBBook = await ctx.program.account.orderBook.fetch(marketB.orderBookPda);
    const marketBObUsdc = await tokenAmount(ctx, marketB.obUsdcVault);
    const marketBObYes = await tokenAmount(ctx, marketB.obYesVault);
    expect(marketBState.outcome).to.deep.equal({ pending: {} });
    expect(marketBVault).to.equal(2_000_000);
    expect(marketBBook.bidCount).to.equal(1);
    expect(marketBBook.askCount).to.equal(1);
    expect(marketBObUsdc).to.equal(400_000);
    expect(marketBObYes).to.equal(1);

    // ── Assert Market C: frozen, orderbook empty after unwind, escrow returned ──
    const marketCState = await ctx.program.account.strikeMarket.fetch(marketC.marketPda);
    const marketCVault = await tokenAmount(ctx, marketC.vaultPda);
    const marketCBook = await ctx.program.account.orderBook.fetch(marketC.orderBookPda);
    const marketCObUsdc = await tokenAmount(ctx, marketC.obUsdcVault);
    const marketCObYes = await tokenAmount(ctx, marketC.obYesVault);
    expect(marketCState.outcome).to.deep.equal({ pending: {} });
    expect(marketCVault).to.equal(2_000_000);
    expect(marketCBook.askCount).to.equal(0);
    expect(marketCObUsdc).to.equal(0);
    expect(marketCObYes).to.equal(0);
  });
});
