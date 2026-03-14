/**
 * Create fresh markets with short-lived close times for rapid local dev cycles.
 * Single-run: ensure USDC + wallets -> settle old -> close settled -> ensure config -> create fresh -> exit.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=.wallets/admin.json npx tsx scripts/cycle.ts
 *
 * Then: make seed-cycle   # seed order books
 *       make settle-cycle # after CYCLE_MINUTES, settle + close
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Meridian } from "../target/types/meridian";
import { getDevWallet } from "./dev-wallets";
import { MAG7_TICKERS, USDC_PER_PAIR } from "./constants";
import {
  ensureUsdcMint,
  fundDevWallets,
  ensureGlobalConfig,
  updateConfigDelay,
  settleAllPending,
  closeAllSettled,
  createMarketsForTickers,
} from "./market-ops";
import { loadUsdcMint, sleep, defaultTxDelay } from "./bot-utils";
import { fetchStockPrices } from "./fair-value";

const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || "12");
const TX_DELAY = defaultTxDelay();

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;
  const admin = provider.wallet;

  const isLocalhost =
    connection.rpcEndpoint.includes("localhost") ||
    connection.rpcEndpoint.includes("127.0.0.1");

  // On localhost, ensure USDC mint exists and wallets are funded (idempotent)
  let usdcMint: anchor.web3.PublicKey;
  if (isLocalhost) {
    const adminKeypair = getDevWallet("admin");
    usdcMint = await ensureUsdcMint(connection, adminKeypair);
    await fundDevWallets(connection, adminKeypair, usdcMint);
  } else {
    usdcMint = loadUsdcMint();
  }

  const nowSecs = Math.floor(Date.now() / 1000);

  console.log("=== Market Cycle ===");
  console.log(`Program: ${program.programId.toString()}`);
  console.log(`Admin: ${admin.publicKey.toString()}`);
  console.log(`USDC Mint: ${usdcMint.toString()}`);
  console.log(`Cycle duration: ${CYCLE_MINUTES} minutes`);

  // Step 1: Settle any unsettled markets past their close time
  console.log("\n[1/5] Settling previous cycle markets...");
  const settledCount = await settleAllPending(program, admin.publicKey);
  console.log(`  Settled ${settledCount} markets.`);
  await sleep(TX_DELAY);

  // Step 2: Close all settled markets (reclaim rent)
  console.log("\n[2/5] Closing settled markets...");
  const closedCount = await closeAllSettled(program, admin.publicKey);
  console.log(`  Closed ${closedCount} markets.`);

  // Step 3: Ensure GlobalConfig exists
  console.log("\n[3/5] Ensuring config...");
  await ensureGlobalConfig(program, connection, admin.publicKey);

  // Step 4: Set admin_settle_delay to 60s for rapid cycles
  console.log("\n[4/5] Setting admin_settle_delay to 60s...");
  await updateConfigDelay(program, admin.publicKey, 60);

  // Step 5: Create fresh markets with short-lived close times
  console.log("\n[5/5] Creating fresh markets...");

  // KEY-DECISION 2026-03-14: Uses epoch-seconds as PDA date seed (not day number).
  // This ensures unique PDAs per cycle so rapid re-creation doesn't collide.
  const dateSeed = new BN(nowSecs);
  const closeTime = new BN(nowSecs + CYCLE_MINUTES * 60);

  console.log(`  Date seed: ${dateSeed.toString()} (epoch-seconds)`);
  console.log(`  Close time: ${new Date((nowSecs + CYCLE_MINUTES * 60) * 1000).toISOString()}`);

  const stockPrices = await fetchStockPrices();
  const totalCreated = await createMarketsForTickers(
    program,
    admin.publicKey,
    usdcMint,
    MAG7_TICKERS,
    dateSeed,
    closeTime,
    stockPrices,
  );

  // Summary
  const closeAt = new Date((nowSecs + CYCLE_MINUTES * 60) * 1000).toISOString();

  console.log("\n=== Cycle Complete ===");
  console.log(`Markets created: ${totalCreated}`);
  console.log(`Close time: ${closeAt}`);
  console.log(`Admin settle delay: 60s`);
  console.log(`\nNext steps:`);
  console.log(`  1. make seed-cycle   # seed order books with bot liquidity`);
  console.log(`  2. ... trade for ${CYCLE_MINUTES} minutes ...`);
  console.log(`  3. make settle-cycle # settle + close markets`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
