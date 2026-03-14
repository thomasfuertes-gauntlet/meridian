/**
 * Devnet teardown: settle all markets, close them, drain bot wallets to admin.
 * Recovers ~70% of rent (StrikeMarket + OrderBook accounts). Mints and vault
 * PDAs are orphaned (authority was market PDA, now closed).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://... ANCHOR_WALLET=.wallets/admin.json npx tsx scripts/nuke-devnet.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Meridian } from "../target/types/meridian";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getDevWallet } from "./dev-wallets";
import { USDC_PER_PAIR } from "./constants";
import { sleep } from "./bot-utils";
import {
  TOKEN_PROGRAM_ID,
  closeAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  transfer,
} from "@solana/spl-token";
import * as readline from "readline";

const TX_DELAY = 1500; // devnet rate-limit spacing
const RETRY_DELAY_MS = 10_000;
const MAX_SETTLE_WAIT_MS = 90 * 60 * 1000;

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function main() {
  // Step 1: Refuse localhost (check before provider init to fail fast)
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "";
  if (rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")) {
    console.error(
      "Nuke is for devnet only. For local, just restart the validator."
    );
    process.exit(1);
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;
  const adminKeypair = (provider.wallet as anchor.Wallet).payer;
  const endpoint = connection.rpcEndpoint;

  const botA = getDevWallet("bot-a");
  const botB = getDevWallet("bot-b");

  // Step 2: Print current state
  console.log("=== Meridian Devnet Nuke ===");
  console.log(`RPC: ${endpoint}`);
  console.log(`Program: ${program.programId.toString()}`);
  console.log(`Admin: ${adminKeypair.publicKey.toString()}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();

  let pendingCount = 0;
  let frozenCount = 0;
  let settledCount = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of allMarkets) {
    if ("pending" in m.account.outcome) pendingCount++;
    else if ("settled" in m.account.status) settledCount++;
    // Frozen markets have pending outcome but frozen status
    if ("frozen" in m.account.status) frozenCount++;
  }

  const adminBalBefore = await connection.getBalance(adminKeypair.publicKey);
  const botABal = await connection.getBalance(botA.publicKey);
  const botBBal = await connection.getBalance(botB.publicKey);

  console.log(`\nMarkets: ${allMarkets.length} total`);
  console.log(`  Pending: ${pendingCount}`);
  console.log(`  Frozen: ${frozenCount}`);
  console.log(`  Settled: ${settledCount}`);
  console.log(
    `\nAdmin SOL: ${(adminBalBefore / LAMPORTS_PER_SOL).toFixed(4)}`
  );
  console.log(`Bot-A SOL: ${(botABal / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`Bot-B SOL: ${(botBBal / LAMPORTS_PER_SOL).toFixed(4)}`);

  if (allMarkets.length === 0 && botABal <= 5000 && botBBal <= 5000) {
    console.log("\nNothing to nuke. Exiting.");
    process.exit(0);
  }

  // Step 3: Confirmation prompt
  const yes = await confirm(
    `\nNuke ${allMarkets.length} markets on devnet? This is irreversible. [y/N] `
  );
  if (!yes) {
    console.log("Aborted.");
    process.exit(0);
  }

  // Step 4: Force-settle all pending/frozen markets via admin_settle
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsettled = allMarkets.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m: any) => "pending" in m.account.outcome
  );

  if (unsettled.length > 0) {
    console.log(`\n[1/4] Settling ${unsettled.length} unsettled markets...`);
    let settledOk = 0;
    let settleErrors = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of unsettled) {
      const ticker = m.account.ticker as string;
      const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
      // Synthetic price: $1 above strike -> YesWins
      const syntheticPrice = m.account.strikePrice.toNumber() + 1_000_000;

      const [orderBookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), m.publicKey.toBuffer()],
        program.programId
      );

      const startMs = Date.now();
      let success = false;

      while (Date.now() - startMs < MAX_SETTLE_WAIT_MS) {
        try {
          await program.methods
            .adminSettle(new BN(syntheticPrice))
            .accountsPartial({
              admin: adminKeypair.publicKey,
              market: m.publicKey,
            })
            .remainingAccounts([
              { pubkey: orderBookPda, isSigner: false, isWritable: true },
            ])
            .signers([adminKeypair])
            .rpc();
          console.log(`  Settled: ${ticker} > $${strikeDollars}`);
          settledOk++;
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
            settledOk++;
            success = true;
            break;
          }
          if (msg.includes("AdminSettleTooEarly")) {
            console.log(
              `  ${ticker} > $${strikeDollars}: admin_settle_delay not met, retrying in ${RETRY_DELAY_MS / 1000}s...`
            );
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          console.warn(
            `  Warning: settle failed for ${ticker} > $${strikeDollars}: ${msg.slice(0, 120)}`
          );
          settleErrors++;
          break;
        }
      }

      if (!success && settleErrors === 0) {
        console.warn(
          `  Warning: timed out settling ${ticker} > $${strikeDollars}`
        );
        settleErrors++;
      }
    }
    console.log(
      `  Settle complete: ${settledOk} ok, ${settleErrors} errors`
    );
  } else {
    console.log("\n[1/4] No unsettled markets.");
  }

  // Step 5: Close all settled markets (force=true)
  console.log("\n[2/4] Closing settled markets...");
  // Re-fetch to include newly settled ones
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refreshed = await (program.account as any).strikeMarket.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toClose = refreshed.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m: any) => "settled" in m.account.status
  );

  let closedCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of toClose) {
    const ticker = m.account.ticker as string;
    const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
    try {
      const [orderBookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), m.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .closeMarket(true) // force=true: skip unclaimed credits check
        .accountsPartial({
          admin: adminKeypair.publicKey,
          market: m.publicKey,
          orderBook: orderBookPda,
        })
        .signers([adminKeypair])
        .rpc();
      console.log(`  Closed: ${ticker} > $${strikeDollars}`);
      closedCount++;
      await sleep(TX_DELAY);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Warning: close failed for ${ticker} > $${strikeDollars}: ${msg.slice(0, 100)}`
      );
    }
  }
  console.log(`  Closed ${closedCount} markets.`);

  // Step 6: Close bot token accounts
  console.log("\n[3/4] Closing bot token accounts...");
  const bots = [
    { name: "bot-a", kp: botA },
    { name: "bot-b", kp: botB },
  ];

  let tokenAccountsClosed = 0;

  for (const bot of bots) {
    try {
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        bot.kp.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      if (tokenAccounts.value.length === 0) {
        console.log(`  ${bot.name}: no token accounts`);
        continue;
      }

      console.log(
        `  ${bot.name}: ${tokenAccounts.value.length} token accounts`
      );

      for (const ta of tokenAccounts.value) {
        try {
          // Parse balance from account data (offset 64, 8 bytes LE)
          const balance = ta.account.data.readBigUInt64LE(64);

          if (balance > 0n) {
            // Try to transfer tokens to admin's ATA before closing
            // Parse mint from token account data (first 32 bytes)
            const mint = new PublicKey(ta.account.data.subarray(0, 32));
            try {
              const adminAta = getAssociatedTokenAddressSync(
                mint,
                adminKeypair.publicKey
              );
              // Create admin ATA if needed
              const createAtaIx =
                createAssociatedTokenAccountIdempotentInstruction(
                  adminKeypair.publicKey,
                  adminAta,
                  adminKeypair.publicKey,
                  mint
                );
              const tx = new Transaction().add(createAtaIx);
              await anchor.web3.sendAndConfirmTransaction(connection, tx, [
                adminKeypair,
              ]);
              await sleep(TX_DELAY);

              // Transfer tokens
              await transfer(
                connection,
                adminKeypair, // payer
                ta.pubkey, // source
                adminAta, // destination
                bot.kp, // owner/authority
                balance
              );
              await sleep(TX_DELAY);
            } catch {
              // Token transfer may fail (e.g., mint closed). That's fine.
            }
          }

          // Close the token account (rent goes to bot wallet owner)
          await closeAccount(
            connection,
            adminKeypair, // payer
            ta.pubkey, // account to close
            bot.kp.publicKey, // destination for rent
            bot.kp // owner
          );
          tokenAccountsClosed++;
          await sleep(TX_DELAY);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `    Warning: failed to close token account ${ta.pubkey.toString().slice(0, 12)}...: ${msg.slice(0, 80)}`
          );
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Warning: failed to enumerate ${bot.name} token accounts: ${msg.slice(0, 80)}`
      );
    }
  }
  console.log(`  Closed ${tokenAccountsClosed} token accounts.`);

  // Step 7: Drain bot SOL to admin
  console.log("\n[4/4] Draining bot SOL to admin...");
  let solDrained = 0;

  for (const bot of bots) {
    try {
      const bal = await connection.getBalance(bot.kp.publicKey);
      const transferAmount = bal - 5000; // keep 5000 lamports for rent-exempt minimum
      if (transferAmount <= 0) {
        console.log(
          `  ${bot.name}: ${(bal / LAMPORTS_PER_SOL).toFixed(6)} SOL (too low to drain)`
        );
        continue;
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: bot.kp.publicKey,
          toPubkey: adminKeypair.publicKey,
          lamports: transferAmount,
        })
      );
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [bot.kp]);
      const drained = transferAmount / LAMPORTS_PER_SOL;
      solDrained += drained;
      console.log(`  ${bot.name}: drained ${drained.toFixed(6)} SOL`);
      await sleep(TX_DELAY);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Warning: failed to drain ${bot.name}: ${msg.slice(0, 80)}`
      );
    }
  }

  // Step 8: Print recovery report
  const adminBalAfter = await connection.getBalance(adminKeypair.publicKey);
  const totalRecovered =
    (adminBalAfter - adminBalBefore) / LAMPORTS_PER_SOL;
  const orphanedAccounts = closedCount * 5; // yes_mint, no_mint, vault, ob_usdc_vault, ob_yes_vault

  console.log("\n=== Nuke Complete ===");
  console.log(
    `Admin SOL before: ${(adminBalBefore / LAMPORTS_PER_SOL).toFixed(4)}`
  );
  console.log(
    `Admin SOL after:  ${(adminBalAfter / LAMPORTS_PER_SOL).toFixed(4)}`
  );
  console.log(`Total SOL recovered: ${totalRecovered.toFixed(4)}`);
  console.log(`Markets closed: ${closedCount}`);
  console.log(`Token accounts closed: ${tokenAccountsClosed}`);
  console.log(
    `Orphaned accounts: ${orphanedAccounts} (${closedCount} markets x 5: yes_mint, no_mint, vault, ob_usdc_vault, ob_yes_vault)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
