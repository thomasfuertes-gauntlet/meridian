/**
 * Devnet infrastructure setup: config, USDC mint, bot funding.
 * Idempotent - safe to run multiple times.
 *
 * Market creation is handled by the automation cron (morning-job.ts).
 * Run `npx tsx scripts/automation.ts --now` to bootstrap markets immediately.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=.wallets/admin.json \
 *     npx tsx scripts/setup-devnet.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import { USDC_DECIMALS, USDC_PER_PAIR } from "./constants";
import { accountExists } from "./market-ops";
import { sleep, defaultTxDelay } from "./bot-utils";

const DEVNET_DELAY_MS = defaultTxDelay();

/** Fund a wallet with SOL from admin (devnet airdrops are heavily rate-limited) */
async function fundFromAdmin(
  connection: anchor.web3.Connection,
  admin: anchor.web3.Keypair,
  recipient: PublicKey,
  lamports: number
): Promise<void> {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const tx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: recipient,
          lamports,
        })
      );
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [admin]);
      return;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      console.log(`  Transfer retry ${i + 1}/${maxRetries}...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet;
  const connection = provider.connection;

  const adminKeypair = getDevWallet("admin");
  const botA = getDevWallet("bot-a");
  const botB = getDevWallet("bot-b");

  console.log("=== Meridian Devnet Setup ===");
  console.log("Program ID:", program.programId.toString());
  console.log("Admin:", admin.publicKey.toString());
  console.log("Bot-A:", botA.publicKey.toString());
  console.log("Bot-B:", botB.publicKey.toString());

  // Check balances
  const adminBal = await connection.getBalance(adminKeypair.publicKey);
  const botABal = await connection.getBalance(botA.publicKey);
  const botBBal = await connection.getBalance(botB.publicKey);

  console.log(`\nBalances: admin=${(adminBal / LAMPORTS_PER_SOL).toFixed(2)} SOL, bot-a=${(botABal / LAMPORTS_PER_SOL).toFixed(2)} SOL, bot-b=${(botBBal / LAMPORTS_PER_SOL).toFixed(2)} SOL`);

  if (adminBal < 2 * LAMPORTS_PER_SOL) {
    console.error("Admin SOL too low (<2). Fund admin wallet via faucet.solana.com or solana airdrop.");
    process.exit(1);
  }
  if (botABal < 1 * LAMPORTS_PER_SOL) {
    console.log("Bot-A needs SOL. Transferring 2 SOL from admin...");
    await fundFromAdmin(connection, adminKeypair, botA.publicKey, 2 * LAMPORTS_PER_SOL);
    await sleep(DEVNET_DELAY_MS);
  }
  if (botBBal < 1 * LAMPORTS_PER_SOL) {
    console.log("Bot-B needs SOL. Transferring 2 SOL from admin...");
    await fundFromAdmin(connection, adminKeypair, botB.publicKey, 2 * LAMPORTS_PER_SOL);
    await sleep(DEVNET_DELAY_MS);
  }

  // Check if USDC mint already exists (from previous run)
  let usdcMint: PublicKey;
  const existingMint = process.env.USDC_MINT;
  if (existingMint) {
    usdcMint = new PublicKey(existingMint);
    console.log("\nUsing existing USDC mint:", usdcMint.toString());
  } else {
    // Create new USDC mint
    usdcMint = await createMint(
      connection,
      adminKeypair,
      adminKeypair.publicKey,
      null,
      USDC_DECIMALS
    );
    console.log("\nCreated USDC Mint:", usdcMint.toString());
  }

  // Create admin USDC ATA and mint USDC
  let adminUsdcAta: PublicKey;
  const adminAtaAddr = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
  if (await accountExists(connection, adminAtaAddr)) {
    adminUsdcAta = adminAtaAddr;
  } else {
    adminUsdcAta = await createAssociatedTokenAccount(
      connection,
      adminKeypair,
      usdcMint,
      admin.publicKey
    );
  }
  await mintTo(connection, adminKeypair, usdcMint, adminUsdcAta, adminKeypair, 1000 * USDC_PER_PAIR);
  console.log("Minted 1000 USDC to admin");
  await sleep(DEVNET_DELAY_MS);

  // Fund bot-a with USDC for market making
  const botAUsdcAta = getAssociatedTokenAddressSync(usdcMint, botA.publicKey);
  const createBotAAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    adminKeypair.publicKey,
    botAUsdcAta,
    botA.publicKey,
    usdcMint
  );
  const botAAtaTx = new anchor.web3.Transaction().add(createBotAAtaIx);
  await anchor.web3.sendAndConfirmTransaction(connection, botAAtaTx, [adminKeypair]);
  await mintTo(connection, adminKeypair, usdcMint, botAUsdcAta, adminKeypair, 250_000 * USDC_PER_PAIR);
  console.log("Minted 250,000 USDC to bot-a");
  await sleep(DEVNET_DELAY_MS);

  // Fund bot-b with USDC for frontend trading
  const botBUsdcAta = getAssociatedTokenAddressSync(usdcMint, botB.publicKey);
  const createBotBAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    adminKeypair.publicKey,
    botBUsdcAta,
    botB.publicKey,
    usdcMint
  );
  const botBAtaTx = new anchor.web3.Transaction().add(createBotBAtaIx);
  await anchor.web3.sendAndConfirmTransaction(connection, botBAtaTx, [adminKeypair]);
  await mintTo(connection, adminKeypair, usdcMint, botBUsdcAta, adminKeypair, 250_000 * USDC_PER_PAIR);
  console.log("Minted 250,000 USDC to bot-b");
  await sleep(DEVNET_DELAY_MS);

  // Initialize config
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  if (await accountExists(connection, configPda)) {
    console.log("Config already initialized, skipping");
  } else {
    await program.methods
      .initializeConfig()
      .accountsPartial({ admin: admin.publicKey })
      .rpc();
    console.log("Config initialized");
  }

  // Market creation is handled by the automation cron (morning-job.ts at 8 AM ET).
  // Run `npx tsx scripts/automation.ts --now` to bootstrap markets immediately.

  // Write local-config.json for local testing against devnet
  const fs = await import("fs");
  const configPath = `${import.meta.dirname}/../frontend/src/lib/local-config.json`;
  fs.writeFileSync(
    configPath,
    JSON.stringify({ usdcMint: usdcMint.toString() }, null, 2)
  );

  console.log("\n=== Devnet Setup Complete ===");
  console.log(`USDC Mint: ${usdcMint.toString()}`);
  console.log(`\nEnsure .env has: DEVNET_USDC_MINT=${usdcMint.toString()}`);
  console.log(`To create markets: npx tsx scripts/automation.ts --now`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
