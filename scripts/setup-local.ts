/**
 * Local development setup script.
 * Run after `anchor deploy` on local validator.
 * Idempotent - safe to run multiple times.
 *
 * Creates: config, USDC mint, and spec-aligned daily strike markets for MAG7,
 * plus order books and dev wallet funding.
 *
 * Uses deterministic dev wallets from scripts/dev-wallets.ts.
 * Admin wallet is both program admin and USDC mint authority.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Meridian } from "../target/types/meridian";
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import { fetchStockPrices } from "./fair-value";
import { calculateStrikes } from "../automation/src/strikes.js";

const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

const USDC_DECIMALS = 6;
const USDC_PER_PAIR = 1_000_000;
// Use a recent past unix timestamp so admin_settle works immediately while
// still satisfying close_time > date.
const pastCloseTime = new BN(Math.floor(Date.now() / 1000) - 7200);
const today = new BN(Math.floor(Date.now() / 86400000));

async function accountExists(
  connection: anchor.web3.Connection,
  pubkey: PublicKey
): Promise<boolean> {
  const info = await connection.getAccountInfo(pubkey);
  return info !== null;
}

async function ensureSolBalance(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  recipient: PublicKey,
  minimumLamports: number,
  targetLamports: number
): Promise<void> {
  const balance = await connection.getBalance(recipient);
  if (balance >= minimumLamports) return;

  const lamports = Math.max(0, targetLamports - balance);
  if (lamports === 0) return;

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports,
    })
  );
  await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer]);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet;
  const connection = provider.connection;

  // Admin wallet is also the USDC mint authority (deterministic, no random keypair)
  const adminKeypair = getDevWallet("admin");
  const botB = getDevWallet("bot-b");

  console.log("Program ID:", program.programId.toString());
  console.log("Admin:", admin.publicKey.toString());

  // Optional: fund a browser wallet (pass pubkey as CLI arg)
  const browserWallet = process.argv[2] ? new PublicKey(process.argv[2]) : null;
  if (browserWallet) {
    console.log("Browser wallet:", browserWallet.toString());
    await ensureSolBalance(
      connection,
      adminKeypair,
      browserWallet,
      2 * LAMPORTS_PER_SOL,
      5 * LAMPORTS_PER_SOL
    );
    console.log("Funded browser wallet with 5 SOL");
  }

  // Fund bot-b for frontend auto-sign
  await ensureSolBalance(
    connection,
    adminKeypair,
    botB.publicKey,
    2 * LAMPORTS_PER_SOL,
    5 * LAMPORTS_PER_SOL
  );
  console.log("Funded bot-b (frontend auto-sign):", botB.publicKey.toString());

  // 1. Create USDC mint (admin is mint authority)
  const usdcMint = await createMint(
    connection,
    adminKeypair,
    adminKeypair.publicKey,
    null,
    USDC_DECIMALS
  );
  console.log("USDC Mint:", usdcMint.toString());

  // 2. Create admin USDC ATA and mint USDC
  const adminUsdcAta = await createAssociatedTokenAccount(
    connection,
    adminKeypair,
    usdcMint,
    admin.publicKey
  );
  await mintTo(
    connection,
    adminKeypair,
    usdcMint,
    adminUsdcAta,
    adminKeypair,
    1000 * USDC_PER_PAIR
  );
  console.log("Minted 1000 USDC to admin");

  // 3. Fund browser wallet with USDC
  if (browserWallet) {
    const browserUsdcAta = getAssociatedTokenAddressSync(usdcMint, browserWallet);
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      adminKeypair.publicKey,
      browserUsdcAta,
      browserWallet,
      usdcMint
    );
    const tx = new anchor.web3.Transaction().add(createAtaIx);
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [adminKeypair]);
    await mintTo(
      connection,
      adminKeypair,
      usdcMint,
      browserUsdcAta,
      adminKeypair,
      100 * USDC_PER_PAIR
    );
    console.log("Minted 100 USDC to browser wallet");
  }

  // 4. Fund bot-b with USDC for frontend trading
  const botBUsdcAta = getAssociatedTokenAddressSync(usdcMint, botB.publicKey);
  const createBotBAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    adminKeypair.publicKey,
    botBUsdcAta,
    botB.publicKey,
    usdcMint
  );
  const botBAtaTx = new anchor.web3.Transaction().add(createBotBAtaIx);
  await anchor.web3.sendAndConfirmTransaction(connection, botBAtaTx, [adminKeypair]);
  await mintTo(
    connection,
    adminKeypair,
    usdcMint,
    botBUsdcAta,
    adminKeypair,
    10_000 * USDC_PER_PAIR
  );
  console.log("Minted 10,000 USDC to bot-b");

  // 5. Initialize config (skip if already exists)
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

  // 6. Fetch reference prices and generate strikes per ticker
  console.log("Fetching reference prices for strike generation...");
  const refPrices = await fetchStockPrices();
  let totalMarkets = 0;

  for (const ticker of MAG7_TICKERS) {
    const refPrice = refPrices.get(ticker);
    if (!refPrice) {
      console.warn(`  No reference price for ${ticker}, skipping`);
      continue;
    }
    const strikes = calculateStrikes(refPrice);
    console.log(`  ${ticker} ref=$${refPrice.toFixed(2)} -> strikes: ${strikes.map((s) => `$${s}`).join(", ")}`);

    for (const strikeDollars of strikes) {
      const strike = strikeDollars * USDC_PER_PAIR; // convert to USDC base units
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

      // Skip if market already exists
      if (await accountExists(connection, marketPda)) {
        console.log(`    ${ticker} > $${strikeDollars} already exists, skipping`);
        totalMarkets++;
        continue;
      }

      await program.methods
        .createStrikeMarket(ticker, strikePrice, today, pastCloseTime)
        .accountsPartial({ admin: admin.publicKey, usdcMint })
        .rpc();

      console.log(`    Created: ${ticker} > $${strikeDollars}`);
      totalMarkets++;
    }
  }

  // Write config for frontend + bot scripts
  const fs = await import("fs");
  const configPath = `${import.meta.dirname}/../frontend/src/lib/local-config.json`;
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      usdcMint: usdcMint.toString(),
    }, null, 2)
  );
  console.log(`\nWrote ${configPath}`);

  // Print summary
  console.log("\n--- Setup Complete ---");
  console.log(`USDC Mint: ${usdcMint.toString()}`);
  console.log(`Markets created: ${totalMarkets}`);
  console.log(`bot-b (frontend): ${botB.publicKey.toString()} - 100 USDC + 5 SOL`);
  if (browserWallet) {
    console.log(`Browser wallet ${browserWallet.toString()} funded with:`);
    console.log(`  5 SOL (tx fees) + 100 USDC (trading)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
