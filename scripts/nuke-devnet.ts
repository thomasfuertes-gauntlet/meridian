/**
 * Devnet teardown: settle all markets, close them, drain bot wallets to admin.
 * Recovers ~70% of rent (StrikeMarket + OrderBook accounts). Mints and vault
 * PDAs are orphaned (authority was market PDA, now closed).
 *
 * Uses fire-and-forget pattern (sendNoConfirm + batchConfirm) to minimize
 * Helius credit usage: ~1 credit/tx instead of ~3.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://... ANCHOR_WALLET=.wallets/admin.json npx tsx scripts/nuke-devnet.ts
 *
 * Flags:
 *   --yes, -y       Skip interactive confirmation prompt
 *   --hard          PERMANENTLY close the program account (recovers rent but program ID
 *                   can NEVER be redeployed). Only use for final teardown, not iteration.
 *   --skip-settle   Skip step 1 (settle markets) - use when markets already settled or pre-CLOB
 *   --skip-close    Skip step 2 (close markets) - use when only draining wallets
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
import { sleep, defaultTxDelay, sendNoConfirm, batchConfirm } from "./bot-utils";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import * as readline from "readline";

const SEND_DELAY = defaultTxDelay();

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
  // Parse CLI flags
  const args = process.argv.slice(2);
  const SKIP_CONFIRM = args.includes("--yes") || args.includes("-y");
  const HARD_MODE = args.includes("--hard");
  const SKIP_SETTLE = args.includes("--skip-settle");
  const SKIP_CLOSE = args.includes("--skip-close");
  let HARD_MODE_SKIPPED = false;
  const totalSteps = HARD_MODE ? 5 : 4;

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

  const ALL_WALLETS = [
    { name: "bot-a", kp: getDevWallet("bot-a") },
    { name: "bot-b", kp: getDevWallet("bot-b") },
  ];

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
    if ("frozen" in m.account.status) frozenCount++;
  }

  const adminBalBefore = await connection.getBalance(adminKeypair.publicKey);

  let totalWalletSol = 0;
  let walletsWithBalance = 0;
  for (const w of ALL_WALLETS) {
    const bal = await connection.getBalance(w.kp.publicKey);
    if (bal > 5000) {
      totalWalletSol += bal;
      walletsWithBalance++;
    }
  }

  console.log(`\nMarkets: ${allMarkets.length} total`);
  console.log(`  Pending: ${pendingCount}`);
  console.log(`  Frozen: ${frozenCount}`);
  console.log(`  Settled: ${settledCount}`);
  console.log(
    `\nAdmin SOL: ${(adminBalBefore / LAMPORTS_PER_SOL).toFixed(4)}`
  );
  console.log(
    `\nWallets: ${walletsWithBalance}/${ALL_WALLETS.length} with balance (${(totalWalletSol / LAMPORTS_PER_SOL).toFixed(4)} SOL total)`
  );

  if (allMarkets.length === 0 && totalWalletSol <= 5000 * ALL_WALLETS.length) {
    console.log("\nNothing to nuke. Exiting.");
    process.exit(0);
  }

  // Step 3: Confirmation prompt
  if (!SKIP_CONFIRM) {
    const yes = await confirm(
      `\nNuke ${allMarkets.length} markets on devnet? This is irreversible. [y/N] `
    );
    if (!yes) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  // Step 4: Fire-and-forget settle all pending/frozen markets
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsettled = allMarkets.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m: any) => "pending" in m.account.outcome
  );

  if (SKIP_SETTLE) {
    console.log(`\n[1/${totalSteps}] Skipping settle (--skip-settle)`);
  } else if (unsettled.length > 0) {
    console.log(
      `\n[1/${totalSteps}] Settling ${unsettled.length} unsettled markets (fire-and-forget)...`
    );
    const settleSigs: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < unsettled.length; i++) {
      const m = unsettled[i];
      const ticker = m.account.ticker as string;
      const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
      const syntheticPrice = m.account.strikePrice.toNumber() + 1_000_000;

      const [orderBookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), m.publicKey.toBuffer()],
        program.programId
      );

      try {
        const ix = await program.methods
          .adminSettle(new BN(syntheticPrice))
          .accountsPartial({ admin: adminKeypair.publicKey, market: m.publicKey })
          .remainingAccounts([{ pubkey: orderBookPda, isSigner: false, isWritable: true }])
          .instruction();

        const tx = new Transaction().add(ix);
        const sig = await sendNoConfirm(connection, tx, [adminKeypair]);
        settleSigs.push(sig);
        process.stdout.write(
          `\r  Sent ${i + 1}/${unsettled.length}: ${ticker} > $${strikeDollars}    `
        );
      } catch {
        process.stdout.write(
          `\r  Skip ${i + 1}/${unsettled.length}: ${ticker} > $${strikeDollars} (build failed)    `
        );
      }
      await sleep(SEND_DELAY);
    }

    console.log(`\n  Confirming ${settleSigs.length} settle txs...`);
    const settleResult = await batchConfirm(connection, settleSigs);
    console.log(
      `  Settle: ${settleResult.confirmed} confirmed, ${settleResult.failed} failed`
    );
  } else {
    console.log(`\n[1/${totalSteps}] No unsettled markets.`);
  }

  // Step 5: Fire-and-forget close all markets
  // Skip re-fetch - just try to close everything from original list.
  // Unsettled markets that failed to settle will fail to close (fine).
  const closeSigs: string[] = [];
  let closeResult = { confirmed: 0, failed: 0 };

  if (SKIP_CLOSE) {
    console.log(`\n[2/${totalSteps}] Skipping close (--skip-close)`);
  } else {
    console.log(`\n[2/${totalSteps}] Closing ${allMarkets.length} markets (fire-and-forget)...`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < allMarkets.length; i++) {
      const m = allMarkets[i];
      const ticker = m.account.ticker as string;
      const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;

      const [orderBookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), m.publicKey.toBuffer()],
        program.programId
      );

      try {
        const ix = await program.methods
          .closeMarket()
          .accountsPartial({ admin: adminKeypair.publicKey, market: m.publicKey, orderBook: orderBookPda })
          .instruction();

        const tx = new Transaction().add(ix);
        const sig = await sendNoConfirm(connection, tx, [adminKeypair]);
        closeSigs.push(sig);
        process.stdout.write(
          `\r  Sent ${i + 1}/${allMarkets.length}: ${ticker} > $${strikeDollars}    `
        );
      } catch {
        process.stdout.write(
          `\r  Skip ${i + 1}/${allMarkets.length}: ${ticker} > $${strikeDollars} (build failed)    `
        );
      }
      await sleep(SEND_DELAY);
    }

    console.log(`\n  Confirming ${closeSigs.length} close txs...`);
    closeResult = await batchConfirm(connection, closeSigs);
    console.log(
      `  Close: ${closeResult.confirmed} confirmed, ${closeResult.failed} failed`
    );
  }

  // Step 6: Close wallet token accounts (fire-and-forget with batched ops)
  console.log(`\n[3/${totalSteps}] Closing wallet token accounts...`);
  const tokenSigs: string[] = [];

  for (const bot of ALL_WALLETS) {
    try {
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        bot.kp.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      if (tokenAccounts.value.length === 0) continue;

      let withBalance = 0;
      let empty = 0;
      for (const ta of tokenAccounts.value) {
        const bal = ta.account.data.readBigUInt64LE(64);
        if (bal > 0n) withBalance++;
        else empty++;
      }
      console.log(
        `  ${bot.name}: ${tokenAccounts.value.length} token accounts (${withBalance} with balance, ${empty} empty)`
      );

      for (const ta of tokenAccounts.value) {
        try {
          const balance = ta.account.data.readBigUInt64LE(64);
          const mint = new PublicKey(ta.account.data.subarray(0, 32));
          const mintStr = mint.toString().slice(0, 8);
          const tx = new Transaction();

          if (balance > 0n) {
            // Combine: create admin ATA + transfer + close in one tx
            const adminAta = getAssociatedTokenAddressSync(
              mint,
              adminKeypair.publicKey
            );
            tx.add(
              createAssociatedTokenAccountIdempotentInstruction(
                adminKeypair.publicKey,
                adminAta,
                adminKeypair.publicKey,
                mint
              )
            );
            tx.add(
              createTransferInstruction(
                ta.pubkey,       // source
                adminAta,        // destination
                bot.kp.publicKey, // authority
                balance
              )
            );
            console.log(`    ${mintStr}... transfer ${balance} + close`);
          } else {
            console.log(`    ${mintStr}... close (empty)`);
          }

          // Close the token account (rent → bot wallet)
          tx.add(
            createCloseAccountInstruction(
              ta.pubkey,         // account to close
              bot.kp.publicKey,  // destination for rent
              bot.kp.publicKey   // authority
            )
          );

          const sig = await sendNoConfirm(connection, tx, [adminKeypair, bot.kp]);
          tokenSigs.push(sig);
          await sleep(SEND_DELAY);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`    failed: ${msg.slice(0, 60)}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Warning: failed to enumerate ${bot.name} token accounts: ${msg.slice(0, 80)}`
      );
    }
  }

  if (tokenSigs.length > 0) {
    console.log(`  Confirming ${tokenSigs.length} token close txs...`);
    const tokenResult = await batchConfirm(connection, tokenSigs);
    console.log(
      `  Token accounts: ${tokenResult.confirmed} closed, ${tokenResult.failed} failed`
    );
  } else {
    console.log("  No token accounts to close.");
  }

  // Step 7: Drain wallet SOL to admin (fire-and-forget)
  console.log(`\n[4/${totalSteps}] Draining wallet SOL to admin...`);
  const drainSigs: { sig: string; name: string; amount: number }[] = [];
  let skippedWallets = 0;

  for (const bot of ALL_WALLETS) {
    try {
      const bal = await connection.getBalance(bot.kp.publicKey);
      const transferAmount = bal - 5000; // keep 5000 lamports for rent-exempt minimum
      if (transferAmount <= 0) {
        skippedWallets++;
        continue;
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: bot.kp.publicKey,
          toPubkey: adminKeypair.publicKey,
          lamports: transferAmount,
        })
      );
      const sig = await sendNoConfirm(connection, tx, [bot.kp]);
      const solAmount = transferAmount / LAMPORTS_PER_SOL;
      drainSigs.push({ sig, name: bot.name, amount: solAmount });
      console.log(`  ${bot.name}: ${solAmount.toFixed(6)} SOL → admin`);
      await sleep(SEND_DELAY);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Warning: failed to drain ${bot.name}: ${msg.slice(0, 80)}`
      );
    }
  }
  if (skippedWallets > 0) {
    console.log(`  (${skippedWallets} wallets empty, skipped)`);
  }

  if (drainSigs.length > 0) {
    console.log(`  Confirming ${drainSigs.length} drain txs...`);
    const drainResult = await batchConfirm(connection, drainSigs.map((d) => d.sig));
    console.log(
      `  Drain: ${drainResult.confirmed} confirmed, ${drainResult.failed} failed`
    );
  }

  // Step 8 (--hard only): Close program account - PERMANENT, cannot redeploy to same ID
  if (HARD_MODE) {
    console.log(`\n[5/${totalSteps}] Closing program (PERMANENT - cannot redeploy to this ID)...`);
    if (!SKIP_CONFIRM) {
      const yes = await confirm(
        `\n  WARNING: This permanently destroys program ID ${program.programId.toString()}.\n  You will NEVER be able to deploy to this address again.\n  Are you sure? [y/N] `
      );
      if (!yes) {
        console.log("  Skipped program close.");
        HARD_MODE_SKIPPED = true;
      }
    }
    if (!HARD_MODE_SKIPPED) try {
      const { execFileSync } = await import("child_process");
      const programId = program.programId.toString();
      const keypairPath = process.env.ANCHOR_WALLET || ".wallets/admin.json";
      execFileSync(
        "solana",
        [
          "program",
          "close",
          programId,
          "--url",
          endpoint,
          "--keypair",
          keypairPath,
          "--recipient",
          adminKeypair.publicKey.toString(),
          "--bypass-warning",
        ],
        { stdio: "inherit", timeout: 30_000 }
      );
      console.log(`  Program ${programId} closed.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Warning: program close failed (admin may not be upgrade authority): ${msg.slice(0, 120)}`
      );
    }
  }

  // Final: Print recovery report
  const adminBalAfter = await connection.getBalance(adminKeypair.publicKey);
  const totalRecovered =
    (adminBalAfter - adminBalBefore) / LAMPORTS_PER_SOL;

  console.log("\n=== Nuke Complete ===");
  console.log(
    `Admin SOL before: ${(adminBalBefore / LAMPORTS_PER_SOL).toFixed(4)}`
  );
  console.log(
    `Admin SOL after:  ${(adminBalAfter / LAMPORTS_PER_SOL).toFixed(4)}`
  );
  console.log(`Total SOL recovered: ${totalRecovered.toFixed(4)}`);
  console.log(`Markets closed: ${closeResult.confirmed}`);
  console.log(`Token accounts closed: ${tokenSigs.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
