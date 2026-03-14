/**
 * ALPHA mode: Create fresh markets with short-lived close times for rapid UAT.
 * Single-run: settle old -> close settled -> create fresh -> exit.
 *
 * Usage:
 *   ALPHA=1 ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=.wallets/admin.json npx tsx scripts/alpha-cycle.ts
 *
 * Then: make alpha-seed   # seed order books
 *       make alpha-settle # after ALPHA_CYCLE_MINUTES, settle + close
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import { fetchStockPrices } from "./fair-value";
import { calculateStrikes } from "../automation/src/strikes.js";
import { loadUsdcMint, USDC_PER_PAIR, sleep, isRemoteRpc } from "./bot-utils";
import { MAG7_TICKERS } from "./constants";
const ALPHA_CYCLE_MINUTES = Number(process.env.ALPHA_CYCLE_MINUTES || "12");
const TX_DELAY = isRemoteRpc() ? 1500 : 0;

async function accountExists(connection: anchor.web3.Connection, pubkey: PublicKey): Promise<boolean> {
  const info = await connection.getAccountInfo(pubkey);
  return info !== null;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;
  const admin = provider.wallet;

  const usdcMint = loadUsdcMint();

  console.log("=== ALPHA Cycle ===");
  console.log(`Program: ${program.programId.toString()}`);
  console.log(`Admin: ${admin.publicKey.toString()}`);
  console.log(`USDC Mint: ${usdcMint.toString()}`);
  console.log(`Cycle duration: ${ALPHA_CYCLE_MINUTES} minutes`);

  // Step 1: Settle any unsettled markets past their close time
  console.log("\n[1/4] Settling previous cycle markets...");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  const nowSecs = Math.floor(Date.now() / 1000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsettled = allMarkets.filter((m: any) => {
    const isPending = "pending" in m.account.outcome;
    const closeTime = m.account.closeTime.toNumber();
    return isPending && closeTime < nowSecs;
  });

  if (unsettled.length > 0) {
    console.log(`  Found ${unsettled.length} unsettled markets, admin_settling...`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of unsettled) {
      const ticker = m.account.ticker as string;
      const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
      // Synthetic price: $1 above strike (YesWins for ALPHA)
      const syntheticPrice = m.account.strikePrice.toNumber() + 1_000_000;

      const [orderBookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), m.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .adminSettle(new BN(syntheticPrice))
          .accountsPartial({
            admin: admin.publicKey,
            market: m.publicKey,
          })
          .remainingAccounts([
            { pubkey: orderBookPda, isSigner: false, isWritable: true },
          ])
          .rpc();
        console.log(`    Settled: ${ticker} > $${strikeDollars}`);
        await sleep(TX_DELAY);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("AlreadySettled") || msg.includes("already settled") || msg.includes("MarketAlreadySettled")) {
          console.log(`    Already settled: ${ticker} > $${strikeDollars}`);
        } else if (msg.includes("AdminSettleTooEarly")) {
          console.log(`    Too early to settle: ${ticker} > $${strikeDollars} (admin_settle_delay not met)`);
        } else {
          console.error(`    Failed: ${ticker} > $${strikeDollars}: ${msg.slice(0, 100)}`);
        }
      }
    }
  } else {
    console.log("  No unsettled markets past close time.");
  }

  // Step 2: Close all settled markets (reclaim rent)
  console.log("\n[2/4] Closing settled markets...");
  // Re-fetch after settlements
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const postSettleMarkets = await (program.account as any).strikeMarket.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settled = postSettleMarkets.filter((m: any) => "settled" in m.account.status);

  let rentReclaimed = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of settled) {
    const ticker = m.account.ticker as string;
    const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
    try {
      const [orderBookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), m.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .closeMarket(true) // force=true for ALPHA (skip unclaimed credits check)
        .accountsPartial({
          admin: admin.publicKey,
          market: m.publicKey,
          orderBook: orderBookPda,
        })
        .rpc();
      console.log(`    Closed: ${ticker} > $${strikeDollars}`);
      rentReclaimed++;
      await sleep(TX_DELAY);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    Failed to close ${ticker} > $${strikeDollars}: ${msg.slice(0, 100)}`);
    }
  }
  console.log(`  Reclaimed rent from ${rentReclaimed} markets.`);

  // Step 3: Create fresh markets with short-lived close times
  console.log("\n[3/4] Creating fresh markets...");

  // KEY-DECISION 2026-03-14: ALPHA uses epoch-seconds as PDA date seed (not day number).
  // This ensures unique PDAs per cycle so rapid re-creation doesn't collide.
  const dateSeed = new BN(nowSecs);
  const closeTime = new BN(nowSecs + ALPHA_CYCLE_MINUTES * 60);

  console.log(`  Date seed: ${dateSeed.toString()} (epoch-seconds)`);
  console.log(`  Close time: ${new Date((nowSecs + ALPHA_CYCLE_MINUTES * 60) * 1000).toISOString()}`);

  const stockPrices = await fetchStockPrices();
  let totalCreated = 0;

  for (const ticker of MAG7_TICKERS) {
    const refPrice = stockPrices.get(ticker);
    if (!refPrice) {
      console.warn(`  No reference price for ${ticker}, using fallback $100`);
    }
    const effectivePrice = refPrice || 100;
    const strikes = calculateStrikes(effectivePrice);
    console.log(`  ${ticker} ref=$${effectivePrice.toFixed(2)} -> ${strikes.length} strikes`);

    for (const strikeDollars of strikes) {
      const strikePrice = new BN(strikeDollars * USDC_PER_PAIR);
      try {
        await program.methods
          .createStrikeMarket(ticker, strikePrice, dateSeed, closeTime)
          .accountsPartial({ admin: admin.publicKey, usdcMint })
          .rpc();
        console.log(`    Created: ${ticker} > $${strikeDollars}`);
        totalCreated++;
        await sleep(TX_DELAY);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already in use")) {
          console.log(`    ${ticker} > $${strikeDollars} already exists`);
          totalCreated++;
        } else {
          console.error(`    Failed: ${ticker} > $${strikeDollars}: ${msg.slice(0, 100)}`);
        }
      }
    }
  }
  console.log(`  Created ${totalCreated} markets.`);

  // Step 4: Ensure GlobalConfig exists (required for admin_settle)
  console.log("\n[4/4] Config check...");
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  if (!(await accountExists(connection, configPda))) {
    await program.methods
      .initializeConfig()
      .accountsPartial({ admin: admin.publicKey })
      .rpc();
    console.log("  Config initialized.");
  } else {
    console.log("  Config exists.");
  }

  // Summary
  const closeAt = new Date((nowSecs + ALPHA_CYCLE_MINUTES * 60) * 1000).toISOString();
  // admin_settle_delay defaults to 3600s on mainnet; ALPHA assumes it was set to 60s
  // via an InitializeConfig with custom delay, or simply waits. See alpha-settle.ts.
  const settleAvailableAt = new Date((nowSecs + ALPHA_CYCLE_MINUTES * 60 + 3600) * 1000).toISOString();

  console.log("\n=== ALPHA Cycle Complete ===");
  console.log(`Markets created: ${totalCreated}`);
  console.log(`Close time: ${closeAt}`);
  console.log(`Admin settle available: ${settleAvailableAt} (default 1hr delay; set shorter in GlobalConfig for ALPHA)`);
  console.log(`\nNext steps:`);
  console.log(`  1. make alpha-seed   # seed order books with bot liquidity`);
  console.log(`  2. ... trade for ${ALPHA_CYCLE_MINUTES} minutes ...`);
  console.log(`  3. make alpha-settle # settle + close markets`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
