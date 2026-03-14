/**
 * ALPHA mode: Settle all pending markets and close them (reclaim rent).
 * Uses admin_settle with synthetic price ($1 above strike -> YesWins).
 *
 * Waits for close_time to pass, then waits for admin_settle_delay (configured
 * in GlobalConfig; defaults to 3600s on a fresh chain). For fast ALPHA cycles,
 * ensure GlobalConfig.admin_settle_delay_secs is set low (e.g., 60s) at init time.
 *
 * Usage:
 *   ALPHA=1 ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=.wallets/admin.json npx tsx scripts/alpha-settle.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import { USDC_PER_PAIR, sleep, isRemoteRpc } from "./bot-utils";

const TX_DELAY = isRemoteRpc() ? 1500 : 0;
const RETRY_DELAY_MS = 10_000; // 10s between AdminSettleTooEarly retries
const MAX_SETTLE_WAIT_MS = 90 * 60 * 1000; // 90 minutes max wait per market

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet;

  console.log("=== ALPHA Settle ===");
  console.log(`Program: ${program.programId.toString()}`);
  console.log(`Admin: ${admin.publicKey.toString()}`);

  // Step 1: Settle all pending markets
  console.log("\n[1/2] Settling pending markets...");
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
    const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
    const closeTime = m.account.closeTime.toNumber();

    // Synthetic price: $1 above strike (always settles YesWins for ALPHA)
    const syntheticPrice = m.account.strikePrice.toNumber() + 1_000_000;

    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), m.publicKey.toBuffer()],
      program.programId
    );

    const startMs = Date.now();
    let success = false;

    while (Date.now() - startMs < MAX_SETTLE_WAIT_MS) {
      const nowSecs = Math.floor(Date.now() / 1000);

      // Wait for market close time
      if (nowSecs < closeTime) {
        const waitSecs = closeTime - nowSecs + 1;
        console.log(`  ${ticker} > $${strikeDollars}: waiting ${waitSecs}s for close time...`);
        await sleep(waitSecs * 1000);
        continue;
      }

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
        console.log(`  Settled: ${ticker} > $${strikeDollars}`);
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
  // Re-fetch to include newly settled ones
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refreshed = await (program.account as any).strikeMarket.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settledMarkets = refreshed.filter((m: any) => "settled" in m.account.status);
  console.log(`  Found ${settledMarkets.length} settled markets to close.`);

  let closed = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of settledMarkets) {
    const ticker = m.account.ticker as string;
    const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
    try {
      const [orderBookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), m.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .closeMarket(true) // force=true: skip unclaimed credits check for ALPHA
        .accountsPartial({
          admin: admin.publicKey,
          market: m.publicKey,
          orderBook: orderBookPda,
        })
        .rpc();
      console.log(`  Closed: ${ticker} > $${strikeDollars}`);
      closed++;
      await sleep(TX_DELAY);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed to close: ${ticker} > $${strikeDollars}: ${msg.slice(0, 100)}`);
    }
  }

  // Summary
  console.log("\n=== ALPHA Settle Complete ===");
  console.log(`Settled: ${settled} markets`);
  console.log(`Closed: ${closed} markets`);
  if (settleErrors > 0) {
    console.log(`Errors: ${settleErrors}`);
  }
  console.log(`\nReady for next cycle: make alpha-cycle`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
