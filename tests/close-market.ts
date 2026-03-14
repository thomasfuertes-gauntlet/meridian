import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  setupTestContext,
  TestContext,
  createMarket,
  mintPairForAdmin,
  adminSettleMarket,
  placeBid,
  claimFills,
  tokenAmount,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────
//  CLOSE MARKET
//
//  close_market closes a settled market account (and its orderbook)
//  returning rent to the admin.  The `force` flag bypasses the
//  unclaimed-credits guard.
// ─────────────────────────────────────────────────────────────────

describe("close_market", () => {
  let ctx: TestContext;
  let closeIdx: number;

  function nextDate() {
    return new anchor.BN(closeIdx++);
  }

  before(async () => {
    ctx = await setupTestContext();
    closeIdx = ctx.uniqueTestSeedBase + 20_000;
  });

  // ── Happy path: settle with no resting orders, force=false ──────

  it("closes a settled market with no unclaimed credits (force=false)", async () => {
    const pdas = await createMarket(ctx, "NVDA", new anchor.BN(500_000_000), nextDate());

    // Mint 1 pair so the vault isn't totally empty
    await mintPairForAdmin(ctx, pdas, 1);

    // Settle the market (admin_settle freezes + settles)
    await adminSettleMarket(ctx, pdas, new anchor.BN(600_000_000));

    const adminBefore = await ctx.provider.connection.getBalance(ctx.admin.publicKey);

    // close_market with force=false: no resting orders -> no unclaimed credits -> succeeds
    await ctx.program.methods
      .closeMarket(false)
      .accountsPartial({
        admin: ctx.admin.publicKey,
        market: pdas.marketPda,
        orderBook: pdas.orderBookPda,
      })
      .rpc();

    // Market account must be closed
    const marketInfo = await ctx.provider.connection.getAccountInfo(pdas.marketPda);
    expect(marketInfo).to.be.null;

    // OrderBook account must be closed
    const obInfo = await ctx.provider.connection.getAccountInfo(pdas.orderBookPda);
    expect(obInfo).to.be.null;

    // Admin should have received rent back (net positive after tx fee)
    const adminAfter = await ctx.provider.connection.getBalance(ctx.admin.publicKey);
    expect(adminAfter).to.be.greaterThan(adminBefore - 10_000); // tx fee at most 10k lamports
  });

  // ── Reject close on unsettled market ────────────────────────────

  it("rejects close_market on an unsettled market (MarketNotSettled)", async () => {
    const pdas = await createMarket(ctx, "TSLA", new anchor.BN(300_000_000), nextDate());

    try {
      await ctx.program.methods
        .closeMarket(false)
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

  // ── force=false blocked by unclaimed credits ─────────────────────

  it("rejects close_market(force=false) when there are unclaimed credits", async () => {
    const pdas = await createMarket(ctx, "AAPL", new anchor.BN(200_000_000), nextDate());

    // place_order (bid side) requires user_yes ATA to be initialized
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );

    // Place a resting bid - USDC escrowed in obUsdcVault
    await placeBid(
      ctx,
      pdas,
      ctx.admin.publicKey,
      ctx.adminUsdcAta,
      adminYes,
      500_000,
      1
    );

    // Settle - auto-credits the resting bid's escrowed USDC back to the maker
    await adminSettleMarket(ctx, pdas, new anchor.BN(100_000_000));

    // force=false must fail because the resting bid was credited and not yet claimed
    try {
      await ctx.program.methods
        .closeMarket(false)
        .accountsPartial({
          admin: ctx.admin.publicKey,
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
        })
        .rpc();
      expect.fail("Should have thrown UnclaimedCredits");
    } catch (err: any) {
      expect(err.toString()).to.include("UnclaimedCredits");
    }
  });

  // ── force=true bypasses unclaimed credit check ───────────────────

  it("closes with force=true even when unclaimed credits remain", async () => {
    const pdas = await createMarket(ctx, "META", new anchor.BN(600_000_000), nextDate());

    // place_order (bid side) requires user_yes ATA to be initialized
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );

    // Place a bid -> settlement will auto-credit the escrowed USDC
    await placeBid(
      ctx,
      pdas,
      ctx.admin.publicKey,
      ctx.adminUsdcAta,
      adminYes,
      400_000,
      1
    );

    // Settle (auto-credits the resting bid)
    await adminSettleMarket(ctx, pdas, new anchor.BN(500_000_000));

    // Verify unclaimed credits exist before closing
    const ob = await ctx.program.account.orderBook.fetch(pdas.orderBookPda);
    const hasCredits = (ob.credits as any[]).some(
      (c: any) => c.usdcClaimable > 0 || c.yesClaimable > 0
    );
    expect(hasCredits).to.be.true;

    // force=true must succeed despite unclaimed credits
    await ctx.program.methods
      .closeMarket(true)
      .accountsPartial({
        admin: ctx.admin.publicKey,
        market: pdas.marketPda,
        orderBook: pdas.orderBookPda,
      })
      .rpc();

    // Both accounts must be gone
    const marketInfo = await ctx.provider.connection.getAccountInfo(pdas.marketPda);
    expect(marketInfo).to.be.null;

    const obInfo = await ctx.provider.connection.getAccountInfo(pdas.orderBookPda);
    expect(obInfo).to.be.null;
  });

  // ── Claim credits first, then close normally ─────────────────────

  it("closes cleanly after claim_fills drains credits (force=false)", async () => {
    const pdas = await createMarket(ctx, "MSFT", new anchor.BN(400_000_000), nextDate());

    // place_order (bid side) requires user_yes ATA to be initialized
    const adminYes = await createAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.mintAuthority,
      pdas.yesMintPda,
      ctx.admin.publicKey
    );

    // Place a bid -> settlement will credit escrowed USDC back
    await placeBid(
      ctx,
      pdas,
      ctx.admin.publicKey,
      ctx.adminUsdcAta,
      adminYes,
      450_000,
      1
    );

    // Settle market (auto-credits the resting bid escrow)
    await adminSettleMarket(ctx, pdas, new anchor.BN(350_000_000));

    const usdcBefore = await tokenAmount(ctx, ctx.adminUsdcAta);

    // Claim fills to zero out the credit ledger
    await claimFills(
      ctx,
      pdas,
      ctx.admin.publicKey,
      ctx.adminUsdcAta,
      adminYes
    );

    // Admin should have received the escrowed USDC back (bid price * qty)
    const usdcAfter = await tokenAmount(ctx, ctx.adminUsdcAta);
    expect(usdcAfter).to.be.greaterThan(usdcBefore);

    // Now force=false must succeed (no more credits)
    await ctx.program.methods
      .closeMarket(false)
      .accountsPartial({
        admin: ctx.admin.publicKey,
        market: pdas.marketPda,
        orderBook: pdas.orderBookPda,
      })
      .rpc();

    const marketInfo = await ctx.provider.connection.getAccountInfo(pdas.marketPda);
    expect(marketInfo).to.be.null;
  });
});
