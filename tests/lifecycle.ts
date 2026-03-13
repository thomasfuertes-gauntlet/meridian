import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import {
  setupTestContext,
  TestContext,
  createMarket,
  mintPairForAdmin,
  burnPairForUser,
  redeemForUser,
  adminSettleMarket,
  freezeMarket,
  closeTimeAfter,
  getCurrentUnixTimestamp,
  createFundedUser,
  userTokenAccounts,
  tokenAmount,
} from "./helpers";

describe("lifecycle", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestContext();
  });

  it("initializes global config", async () => {
    const configAccount = await ctx.program.account.globalConfig.fetch(ctx.configPda);
    expect(configAccount.admin.toBase58()).to.equal(ctx.admin.publicKey.toBase58());
    expect(configAccount.paused).to.equal(false);
    expect(configAccount.bump).to.equal(ctx.configBump);
    expect(configAccount.oraclePolicies).to.have.length(7);
    expect(
      configAccount.oraclePolicies.find((policy: any) => policy.ticker === "META")
    ).to.deep.include({
      ticker: "META",
      confidenceFilterBps: 100,
      maxPriceStalenessSecs: new anchor.BN(300),
    });
  });

  // Shared market for mint/burn tests
  const sharedTicker = "META";
  const sharedStrikePrice = new anchor.BN(680_000_000);
  const sharedDate = new anchor.BN(1700000000);
  let sharedMarket: ReturnType<typeof createMarket> extends Promise<infer T> ? T : never;

  it("creates a strike market", async () => {
    sharedMarket = await createMarket(ctx, sharedTicker, sharedStrikePrice, sharedDate);

    const marketAccount = await ctx.program.account.strikeMarket.fetch(sharedMarket.marketPda);
    expect(marketAccount.ticker).to.equal(sharedTicker);
    expect(marketAccount.strikePrice.toNumber()).to.equal(680_000_000);
    expect(marketAccount.outcome).to.deep.equal({ pending: {} });
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(0);
    expect(marketAccount.closeTime.toNumber()).to.equal(
      closeTimeAfter(sharedDate).toNumber()
    );
    expect(marketAccount.orderBook.toBase58()).to.equal(sharedMarket.orderBookPda.toBase58());
    expect(marketAccount.obUsdcVault.toBase58()).to.equal(sharedMarket.obUsdcVault.toBase58());
    expect(marketAccount.obYesVault.toBase58()).to.equal(sharedMarket.obYesVault.toBase58());
  });

  it("rejects create_strike_market for unsupported tickers at the on-chain config boundary", async () => {
    const date = new anchor.BN(1700000001);
    const unsupportedTicker = "QQQ";
    const strikePrice = new anchor.BN(500_000_000);

    try {
      await ctx.program.methods
        .createStrikeMarket(unsupportedTicker, strikePrice, date, closeTimeAfter(date))
        .accountsPartial({ admin: ctx.admin.publicKey, usdcMint: ctx.usdcMint })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("UnsupportedTicker");
    }
  });

  it("rejects create_strike_market from a non-admin signer", async () => {
    const { user } = await createFundedUser(ctx);
    const date = new anchor.BN(1700000002);

    try {
      await ctx.program.methods
        .createStrikeMarket("AAPL", new anchor.BN(510_000_000), date, closeTimeAfter(date))
        .accountsPartial({ admin: user.publicKey, usdcMint: ctx.usdcMint })
        .signers([user])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|2012/);
    }
  });

  it("keeps legacy lifecycle instructions out of the generated IDL and client methods", async () => {
    const instructionNames = ctx.program.idl.instructions.map((ix: any) => ix.name);
    expect(instructionNames).to.not.include("buyNo");
    expect(instructionNames).to.not.include("sellNo");
    expect(instructionNames).to.not.include("burnPair");
    expect((ctx.methods as Record<string, unknown>).buyNo).to.equal(undefined);
    expect((ctx.methods as Record<string, unknown>).sellNo).to.equal(undefined);
    expect((ctx.methods as Record<string, unknown>).burnPair).to.equal(undefined);
  });

  it("add_strike creates another admin-only market with full trading accounts", async () => {
    const ticker = "AAPL";
    const strikePrice = new anchor.BN(520_000_000);
    const date = new anchor.BN(1700000003);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    const marketAccount = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(marketAccount.orderBook.toBase58()).to.equal(pdas.orderBookPda.toBase58());
    expect(marketAccount.obUsdcVault.toBase58()).to.equal(pdas.obUsdcVault.toBase58());
    expect(marketAccount.obYesVault.toBase58()).to.equal(pdas.obYesVault.toBase58());
  });

  it("mints a pair", async () => {
    const { userYes, userNo } = await mintPairForAdmin(ctx, sharedMarket, 1);

    const vaultAccount = await getAccount(ctx.provider.connection, sharedMarket.vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(1_000_000);

    const yesAccount = await getAccount(ctx.provider.connection, userYes);
    expect(Number(yesAccount.amount)).to.equal(1);
    const noAccount = await getAccount(ctx.provider.connection, userNo);
    expect(Number(noAccount.amount)).to.equal(1);

    const marketAccount = await ctx.program.account.strikeMarket.fetch(sharedMarket.marketPda);
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(1);
  });

  it("mints 4 more pairs (total 5)", async () => {
    const { userYes, userNo } = userTokenAccounts(ctx, sharedMarket);

    for (let i = 0; i < 4; i++) {
      await mintPairForAdmin(ctx, sharedMarket, 1);
    }

    const vaultAccount = await getAccount(ctx.provider.connection, sharedMarket.vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(5_000_000);

    const yesAccount = await getAccount(ctx.provider.connection, userYes);
    expect(Number(yesAccount.amount)).to.equal(5);
    const noAccount = await getAccount(ctx.provider.connection, userNo);
    expect(Number(noAccount.amount)).to.equal(5);
  });

  it("burns 2 pairs", async () => {
    const { userYes, userNo } = await burnPairForUser(
      ctx, ctx.admin.publicKey, ctx.adminUsdcAta, sharedMarket, 2
    );

    const vaultAccount = await getAccount(ctx.provider.connection, sharedMarket.vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(3_000_000);

    const yesAccount = await getAccount(ctx.provider.connection, userYes);
    expect(Number(yesAccount.amount)).to.equal(3);
    const noAccount = await getAccount(ctx.provider.connection, userNo);
    expect(Number(noAccount.amount)).to.equal(3);

    const marketAccount = await ctx.program.account.strikeMarket.fetch(sharedMarket.marketPda);
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(3);
  });

  it("mints 10 pairs in a single batch call (amount=10)", async () => {
    const { userYes, userNo } = await mintPairForAdmin(ctx, sharedMarket, 10);

    const vaultAccount = await getAccount(ctx.provider.connection, sharedMarket.vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(13_000_000);

    const yesAccount = await getAccount(ctx.provider.connection, userYes);
    expect(Number(yesAccount.amount)).to.equal(13);
    const noAccount = await getAccount(ctx.provider.connection, userNo);
    expect(Number(noAccount.amount)).to.equal(13);

    const marketAccount = await ctx.program.account.strikeMarket.fetch(sharedMarket.marketPda);
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(13);
  });

  it("rejects mint_pair with amount=0 (InvalidAmount)", async () => {
    try {
      await mintPairForAdmin(ctx, sharedMarket, 0);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidAmount");
    }
  });

  it("rejects pre-settlement complete-set redeem when amount exceeds token balance", async () => {
    try {
      await burnPairForUser(ctx, ctx.admin.publicKey, ctx.adminUsdcAta, sharedMarket, 999);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("rejects mint on settled market", async () => {
    await adminSettleMarket(ctx, sharedMarket, new anchor.BN(680_000_000));

    try {
      await mintPairForAdmin(ctx, sharedMarket, 1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketAlreadySettled");
    }
  });

  it("rejects unsettled redeem without the counterpart token accounts", async () => {
    const ticker = "AAPL";
    const strikePrice = new anchor.BN(200_000_000);
    const date = new anchor.BN(1700000001);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    const { userYes } = await mintPairForAdmin(ctx, pdas, 1);

    try {
      await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, userYes, 1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MissingCounterpartyAccount");
    }
  });

  it("allows pre-settlement complete-set redeem with No as the primary token account", async () => {
    const ticker = "NFLX";
    const strikePrice = new anchor.BN(210_000_000);
    const date = new anchor.BN(17000000015);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    const { userYes, userNo } = await mintPairForAdmin(ctx, pdas, 2);
    const usdcBefore = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);

    await redeemForUser(
      ctx, pdas,
      ctx.admin.publicKey, ctx.adminUsdcAta,
      pdas.noMintPda, userNo, 1,
      undefined,
      [
        { pubkey: pdas.yesMintPda, isWritable: true, isSigner: false },
        { pubkey: userYes, isWritable: true, isSigner: false },
      ]
    );

    const usdcAfter = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);
    const yesAfter = Number((await getAccount(ctx.provider.connection, userYes)).amount);
    const noAfter = Number((await getAccount(ctx.provider.connection, userNo)).amount);
    const vaultAfter = Number((await getAccount(ctx.provider.connection, pdas.vaultPda)).amount);
    const marketAccount = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);

    expect(usdcAfter - usdcBefore).to.equal(1_000_000);
    expect(yesAfter).to.equal(1);
    expect(noAfter).to.equal(1);
    expect(vaultAfter).to.equal(1_000_000);
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(1);
  });

  it("rejects pre-settlement complete-set redeem when the counterpart token account is owned by someone else", async () => {
    const ticker = "ORCL";
    const strikePrice = new anchor.BN(220_000_000);
    const date = new anchor.BN(17000000016);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    const { userYes } = await mintPairForAdmin(ctx, pdas, 1);
    const funded = await createFundedUser(ctx, 1_000_000);
    const otherNo = await createAssociatedTokenAccount(
      ctx.provider.connection,
      funded.user,
      pdas.noMintPda,
      funded.user.publicKey
    );

    try {
      await redeemForUser(
        ctx, pdas,
        ctx.admin.publicKey, ctx.adminUsdcAta,
        pdas.yesMintPda, userYes, 1,
        undefined,
        [
          { pubkey: pdas.noMintPda, isWritable: true, isSigner: false },
          { pubkey: otherNo, isWritable: true, isSigner: false },
        ]
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidCounterpartyAccount");
    }
  });

  it("full lifecycle - Yes wins (at-or-above rule)", async () => {
    const ticker = "MSFT";
    const strikePrice = new anchor.BN(400_000_000);
    const date = new anchor.BN(1700000002);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    const { userYes, userNo } = userTokenAccounts(ctx, pdas);

    const usdcBefore = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);

    for (let i = 0; i < 10; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    const usdcAfterMint = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);
    expect(usdcBefore - usdcAfterMint).to.equal(10_000_000);

    await adminSettleMarket(ctx, pdas, new anchor.BN(400_000_000));

    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.yesMintPda, userYes, 10);

    const usdcAfterYesRedeem = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);
    expect(usdcAfterYesRedeem - usdcAfterMint).to.equal(10_000_000);

    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.noMintPda, userNo, 10);

    const usdcAfterNoRedeem = Number((await getAccount(ctx.provider.connection, ctx.adminUsdcAta)).amount);
    expect(usdcAfterNoRedeem).to.equal(usdcAfterYesRedeem);

    const vaultAccount = await getAccount(ctx.provider.connection, pdas.vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(0);

    const marketAccount = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(0);
  });

  it("full lifecycle - No wins", async () => {
    const ticker = "GOOG";
    const strikePrice = new anchor.BN(150_000_000);
    const date = new anchor.BN(1700000003);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    const { userNo } = userTokenAccounts(ctx, pdas);

    for (let i = 0; i < 5; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    await adminSettleMarket(ctx, pdas, new anchor.BN(140_000_000));

    await redeemForUser(ctx, pdas, ctx.admin.publicKey, ctx.adminUsdcAta, pdas.noMintPda, userNo, 5);

    const vaultAccount = await getAccount(ctx.provider.connection, pdas.vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(0);

    const marketAccount = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(0);
  });

  it("redeems winning tokens after settlement while pre-settlement complete-set exits use redeem", async () => {
    const ticker = "AMZN";
    const strikePrice = new anchor.BN(180_000_000);
    const date = new anchor.BN(1700000004);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    for (let i = 0; i < 3; i++) {
      await mintPairForAdmin(ctx, pdas, 1);
    }

    await adminSettleMarket(ctx, pdas, new anchor.BN(200_000_000));

    await burnPairForUser(ctx, ctx.admin.publicKey, ctx.adminUsdcAta, pdas, 1);

    const vaultAccount = await getAccount(ctx.provider.connection, pdas.vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(2_000_000);

    const marketAccount = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(2);
  });

  it("admin settle at strike exactly -> YesWins (at-or-above)", async () => {
    const ticker = "NVDA";
    const strikePrice = new anchor.BN(500_000_000);
    const date = new anchor.BN(1700000005);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    await adminSettleMarket(ctx, pdas, new anchor.BN(500_000_000));

    const marketAccount = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(marketAccount.outcome).to.deep.equal({ yesWins: {} });
    expect(marketAccount.settledAt).to.not.be.null;
  });

  it("admin settle below strike -> NoWins", async () => {
    const ticker = "TSLA";
    const strikePrice = new anchor.BN(300_000_000);
    const date = new anchor.BN(1700000006);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    await adminSettleMarket(ctx, pdas, new anchor.BN(299_999_999));

    const marketAccount = await ctx.program.account.strikeMarket.fetch(pdas.marketPda);
    expect(marketAccount.outcome).to.deep.equal({ noWins: {} });
  });

  it("rejects admin settle before 1hr delay", async () => {
    const ticker = "AAPL";
    const strikePrice = new anchor.BN(600_000_000);
    const date = new anchor.BN(1700000007);
    const now = await getCurrentUnixTimestamp(ctx);
    const recentCloseTime = new anchor.BN(now - 60);
    const pdas = await createMarket(ctx, ticker, strikePrice, date, recentCloseTime);

    await freezeMarket(ctx, pdas);

    try {
      await ctx.program.methods
        .adminSettle(new anchor.BN(650_000_000))
        .accountsPartial({
          admin: ctx.admin.publicKey,
          config: ctx.configPda,
          market: pdas.marketPda,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("AdminSettleTooEarly");
    }
  });

  it("rejects admin settle on already settled market", async () => {
    const ticker = "META";
    const strikePrice = new anchor.BN(100_000_000);
    const date = new anchor.BN(1700000008);
    const pdas = await createMarket(ctx, ticker, strikePrice, date);

    await adminSettleMarket(ctx, pdas, new anchor.BN(110_000_000));

    try {
      await ctx.program.methods
        .adminSettle(new anchor.BN(90_000_000))
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
});
