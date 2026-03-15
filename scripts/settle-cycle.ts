/**
 * Settle all pending markets and close them (reclaim rent).
 * Uses admin_settle with prices from Pyth Hermes (or synthetic fallback).
 *
 * Waits for close_time to pass, then retries if admin_settle_delay hasn't
 * been met yet. For fast cycles, ensure GlobalConfig.admin_settle_delay_secs
 * is set low (e.g., 60s via cycle.ts).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=.wallets/admin.json npx tsx scripts/settle-cycle.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import { USDC_PER_PAIR } from "./constants";
import { closeAllSettled } from "./market-ops";
import { sleep, defaultTxDelay } from "./bot-utils";
import { fetchStockPrices } from "./fair-value";
import { createMockPriceUpdate } from "./mock-pyth";
import { feedIdToBytes, PYTH_FEED_IDS } from "./pyth";

const TX_DELAY = defaultTxDelay();
const RETRY_DELAY_MS = 10_000; // 10s between AdminSettleTooEarly retries
const MAX_SETTLE_WAIT_MS = 90 * 60 * 1000; // 90 minutes max wait

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet;

  console.log("=== Settle Cycle ===");
  console.log(`Program: ${program.programId.toString()}`);
  console.log(`Admin: ${admin.publicKey.toString()}`);

  // Step 1: Settle all pending markets with retry for AdminSettleTooEarly
  console.log("\n[1/2] Settling pending markets...");

  // Fetch current stock prices for realistic settlement outcomes
  const stockPrices = await fetchStockPrices();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending = allMarkets.filter((m: any) => "pending" in m.account.outcome);
  console.log(`  Found ${pending.length} pending markets.`);

  let settled = 0;
  let settleErrors = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of pending) {
    const ticker = m.account.ticker as string;
    const strikeBaseUnits = m.account.strikePrice.toNumber();
    const strikeDollars = strikeBaseUnits / USDC_PER_PAIR;
    const closeTime = m.account.closeTime.toNumber();

    // Use live/synthetic price if available; fall back to strike + $1 (YesWins)
    const livePrice = stockPrices.get(ticker);
    const syntheticPrice = livePrice
      ? Math.round(livePrice * USDC_PER_PAIR)
      : strikeBaseUnits + 1_000_000;

    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), m.publicKey.toBuffer()],
      program.programId
    );

    const startMs = Date.now();
    let success = false;
    const isLocalnet = provider.connection.rpcEndpoint.includes("127.0.0.1") ||
      provider.connection.rpcEndpoint.includes("localhost");

    while (Date.now() - startMs < MAX_SETTLE_WAIT_MS) {
      const nowSecs = Math.floor(Date.now() / 1000);

      // Wait for market close time
      if (nowSecs < closeTime) {
        const waitSecs = closeTime - nowSecs + 1;
        console.log(`  ${ticker} > $${strikeDollars}: waiting ${waitSecs}s for close time...`);
        await sleep(waitSecs * 1000);
        continue;
      }

      // On localnet, try oracle path first via mock-pyth
      if (isLocalnet && PYTH_FEED_IDS[ticker]) {
        try {
          const priceDollars = syntheticPrice / USDC_PER_PAIR;
          const priceUpdate = await createMockPriceUpdate(provider, {
            feedId: feedIdToBytes(PYTH_FEED_IDS[ticker]),
            priceDollars,
            publishTime: closeTime + 30,
          });

          await program.methods
            .settleMarket()
            .accountsPartial({
              settler: admin.publicKey,
              market: m.publicKey,
              priceUpdate,
            })
            .remainingAccounts([
              { pubkey: orderBookPda, isSigner: false, isWritable: true },
            ])
            .rpc();

          const outcome = syntheticPrice >= strikeBaseUnits ? "YesWins" : "NoWins";
          console.log(`  Settled (oracle): ${ticker} > $${strikeDollars} (${outcome}, price=$${priceDollars.toFixed(2)})`);
          settled++;
          success = true;
          await sleep(TX_DELAY);
          break;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("AlreadySettled") || msg.includes("MarketAlreadySettled")) {
            console.log(`  Already settled: ${ticker} > $${strikeDollars}`);
            settled++;
            success = true;
            break;
          }
          console.log(`  Oracle settle failed, falling back to admin_settle: ${msg.slice(0, 80)}`);
        }
      }

      // Fallback: admin_settle
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

        const outcome = syntheticPrice >= strikeBaseUnits ? "YesWins" : "NoWins";
        console.log(`  Settled: ${ticker} > $${strikeDollars} (${outcome}, price=$${(syntheticPrice / USDC_PER_PAIR).toFixed(2)})`);
        settled++;
        success = true;
        await sleep(TX_DELAY);
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("AlreadySettled") ||
          msg.includes("already settled") ||
          msg.includes("MarketAlreadySettled")
        ) {
          console.log(`  Already settled: ${ticker} > $${strikeDollars}`);
          settled++;
          success = true;
          break;
        }
        if (msg.includes("AdminSettleTooEarly")) {
          console.log(`  ${ticker} > $${strikeDollars}: admin_settle_delay not met, retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        // Unexpected error - log and skip
        console.error(`  Failed: ${ticker} > $${strikeDollars}: ${msg.slice(0, 120)}`);
        settleErrors++;
        break;
      }
    }

    if (!success && settleErrors === 0) {
      console.error(`  Timed out waiting to settle: ${ticker} > $${strikeDollars}`);
      settleErrors++;
    }
  }

  // Step 2: Close all settled markets (force=true, reclaim rent)
  console.log("\n[2/2] Closing settled markets...");
  const closed = await closeAllSettled(program, admin.publicKey);

  // Summary
  console.log("\n=== Settle Cycle Complete ===");
  console.log(`Settled: ${settled} markets`);
  console.log(`Closed: ${closed} markets`);
  if (settleErrors > 0) {
    console.log(`Errors: ${settleErrors}`);
  }
  console.log(`\nReady for next cycle: make cycle`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
