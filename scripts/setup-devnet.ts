/**
 * Devnet setup script.
 * Creates config, USDC mint, markets, and order books.
 * Idempotent - safe to run multiple times.
 *
 * Unlike setup-local.ts, uses a future close_time so settle_market works with
 * actual Pyth oracle data. Feed IDs now live in on-chain config.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=.wallets/admin.json \
 *     npx tsx scripts/setup-devnet.ts
 *
 * Outputs USDC mint address for config/devnet.env.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
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
import { fetchStockPrices } from "./fair-value";
import { calculateStrikes } from "./strikes";
import { MAG7_TICKERS, USDC_DECIMALS, USDC_PER_PAIR } from "./constants";
import { accountExists, withRetry } from "./market-ops";
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

  // Create markets with real Pyth feed IDs
  console.log("\nFetching reference prices for strike generation...");
  const refPrices = await fetchStockPrices();
  let totalMarkets = 0;

  // close_time = today's market close (4:00 PM ET) as Unix timestamp
  // EST = UTC-5, EDT = UTC-4. Rough DST: March(2)-November(10).
  const now = new Date();
  const month = now.getUTCMonth(); // 0-indexed
  const etOffset = (month >= 2 && month <= 10) ? 4 : 5;
  const closeET = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16 + etOffset, 0, 0)
  );
  // If market already closed today, use tomorrow
  if (closeET.getTime() < Date.now()) {
    closeET.setDate(closeET.getDate() + 1);
    // Skip weekends
    while (closeET.getDay() === 0 || closeET.getDay() === 6) {
      closeET.setDate(closeET.getDate() + 1);
    }
  }
  const closeTime = new BN(Math.floor(closeET.getTime() / 1000));
  const today = new BN(Math.floor(Date.now() / 86400000));

  console.log(`Close time: ${closeET.toISOString()} (Unix: ${closeTime.toString()})`);

  for (const ticker of MAG7_TICKERS) {
    const refPrice = refPrices.get(ticker);
    if (!refPrice) {
      console.warn(`  No reference price for ${ticker}, skipping`);
      continue;
    }
    const strikes = calculateStrikes(refPrice);
    console.log(`  ${ticker} ref=$${refPrice.toFixed(2)} -> strikes: ${strikes.map((s) => `$${s}`).join(", ")}`);

    for (const strikeDollars of strikes) {
      const strike = strikeDollars * USDC_PER_PAIR;
      const strikePrice = new BN(strike);
      const [marketPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("market"),
          Buffer.from(ticker),
          strikePrice.toArrayLike(Buffer, "le", 8),
          today.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      if (await accountExists(connection, marketPda)) {
        console.log(`    ${ticker} > $${strikeDollars} already exists, skipping`);
        totalMarkets++;
        continue;
      }

      await withRetry(
        () => program.methods
          .createStrikeMarket(ticker, strikePrice, today, closeTime)
          .accountsPartial({ admin: admin.publicKey, usdcMint })
          .rpc(),
        `createStrikeMarket ${ticker} > $${strikeDollars}`
      );

      await sleep(DEVNET_DELAY_MS);

      console.log(`    Created: ${ticker} > $${strikeDollars}`);
      totalMarkets++;

      await sleep(DEVNET_DELAY_MS);
    }
  }

  // Write local-config.json for local testing against devnet
  const fs = await import("fs");
  const configPath = `${import.meta.dirname}/../frontend/src/lib/local-config.json`;
  fs.writeFileSync(
    configPath,
    JSON.stringify({ usdcMint: usdcMint.toString() }, null, 2)
  );

  console.log("\n=== Devnet Setup Complete ===");
  console.log(`USDC Mint: ${usdcMint.toString()}`);
  console.log(`Markets created: ${totalMarkets}`);
  console.log(`\nEnsure .env has: DEVNET_USDC_MINT=${usdcMint.toString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
