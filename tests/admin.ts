import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  setupTestContext,
  TestContext,
  createMarket,
  mintPairForAdmin,
  adminSettleMarket,
  freezeMarket,
  settleWithOrderBookProof,
  pauseProtocol,
  unpauseProtocol,
  redeemForUser,
  tokenAmount,
  expectIncrease,
} from "./helpers";

describe("pause / unpause", () => {
  let ctx: TestContext;
  let nonAdmin: Keypair;

  const pTicker = "PAUS";
  const pStrike = new anchor.BN(111_000_000);
  const pDate = new anchor.BN(1600000001);
  let pMarket: ReturnType<typeof createMarket> extends Promise<infer T> ? T : never;

  before(async () => {
    ctx = await setupTestContext();

    nonAdmin = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(
      nonAdmin.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(sig);

    pMarket = await createMarket(ctx, pTicker, pStrike, pDate);
  });

  it("pause sets config.paused = true", async () => {
    await pauseProtocol(ctx);

    const config = await ctx.program.account.globalConfig.fetch(ctx.configPda);
    expect(config.paused).to.equal(true);
  });

  it("mint rejected during pause (Paused error)", async () => {
    try {
      await mintPairForAdmin(ctx, pMarket, 1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("Paused");
    }
  });

  it("admin settlement still succeeds while paused", async () => {
    const pausedMarket = await createMarket(ctx, "PAST", new anchor.BN(112_000_000), new anchor.BN(1600000002));

    await freezeMarket(ctx, pausedMarket);
    await settleWithOrderBookProof(ctx, pausedMarket, new anchor.BN(113_000_000));

    const market = await ctx.program.account.strikeMarket.fetch(pausedMarket.marketPda);
    expect(market.outcome).to.deep.equal({ yesWins: {} });
  });

  it("redeem still succeeds while paused", async () => {
    // Unpause to mint + settle, then re-pause to test redeem-while-paused
    await unpauseProtocol(ctx);
    const pausedRedeemMarket = await createMarket(ctx, "PRED", new anchor.BN(113_000_000), new anchor.BN(1600000003));
    const { userYes } = await mintPairForAdmin(ctx, pausedRedeemMarket, 1);

    await adminSettleMarket(ctx, pausedRedeemMarket, new anchor.BN(114_000_000));

    const adminUsdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);
    await pauseProtocol(ctx);

    await redeemForUser(ctx, pausedRedeemMarket, ctx.admin.publicKey, ctx.adminUsdcAta, pausedRedeemMarket.yesMintPda, userYes, 1);

    const adminUsdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    expectIncrease(adminUsdcBefore, adminUsdcAfter, 1_000_000);
  });

  it("unpause sets config.paused = false", async () => {
    await unpauseProtocol(ctx);

    const config = await ctx.program.account.globalConfig.fetch(ctx.configPda);
    expect(config.paused).to.equal(false);
  });

  it("mint succeeds after unpause", async () => {
    await mintPairForAdmin(ctx, pMarket, 1);

    const vaultAccount = await getAccount(ctx.provider.connection, pMarket.vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(1_000_000);
  });

  it("non-admin cannot pause (Unauthorized)", async () => {
    try {
      await pauseProtocol(ctx, nonAdmin.publicKey, [nonAdmin]);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|2012/);
    }
  });

  it("non-admin cannot unpause (Unauthorized)", async () => {
    try {
      await unpauseProtocol(ctx, nonAdmin.publicKey, [nonAdmin]);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|2012/);
    }
  });
});
