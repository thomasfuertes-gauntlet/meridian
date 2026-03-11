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
 * Outputs USDC mint address to stdout for Railway env var configuration.
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
import { fetchStockPrices } from "./fair-value";

const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
// Strike generation uses +/-$10 from nearest rounded reference, no ATM (see generateStrikes)

const DEVNET_DELAY_MS = 1500; // throttle to stay under devnet rate limits
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry an async fn with exponential backoff (handles 429s and transient failures) */
async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === retries - 1) throw err;
      const delay = DEVNET_DELAY_MS * (i + 1);
      console.log(`    Retry ${i + 1}/${retries} for ${label} (${delay}ms): ${msg.slice(0, 80)}`);
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}

/**
 * Generate 2 strikes: nearest $10 below and above reference price.
 * Drops ATM to concentrate liquidity on directional brackets.
 */
function generateStrikes(refPrice: number): number[] {
  const at = Math.round(refPrice / 10) * 10;
  return [at - 10, at + 10];
}

const USDC_DECIMALS = 6;
const USDC_PER_PAIR = 1_000_000;

async function accountExists(
  connection: anchor.web3.Connection,
  pubkey: PublicKey
): Promise<boolean> {
  const info = await connection.getAccountInfo(pubkey);
  return info !== null;
}

/** Request airdrop with retry (devnet rate-limits to 2 SOL/request) */
async function airdropWithRetry(
  connection: anchor.web3.Connection,
  pubkey: PublicKey,
  lamports: number
): Promise<void> {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, lamports);
      await connection.confirmTransaction(sig, "confirmed");
      return;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      console.log(`  Airdrop retry ${i + 1}/${maxRetries}...`);
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
    console.log("Admin needs more SOL. Requesting airdrop...");
    await airdropWithRetry(connection, adminKeypair.publicKey, 2 * LAMPORTS_PER_SOL);
  }
  if (botABal < 1 * LAMPORTS_PER_SOL) {
    console.log("Bot-A needs SOL. Requesting airdrop...");
    await airdropWithRetry(connection, botA.publicKey, 2 * LAMPORTS_PER_SOL);
  }
  if (botBBal < 1 * LAMPORTS_PER_SOL) {
    console.log("Bot-B needs SOL. Requesting airdrop...");
    await airdropWithRetry(connection, botB.publicKey, 2 * LAMPORTS_PER_SOL);
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
  await mintTo(connection, adminKeypair, usdcMint, botBUsdcAta, adminKeypair, 10_000 * USDC_PER_PAIR);
  console.log("Minted 10,000 USDC to bot-b");
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

  // close_time = today's market close (4:05 PM ET) as Unix timestamp
  const now = new Date();
  const etStr = now.toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const closeET = new Date(`${etStr} 16:05:00 EDT`);
  // If market already closed today, use tomorrow
  if (closeET.getTime() < Date.now()) {
    closeET.setDate(closeET.getDate() + 1);
    // Skip weekends
    while (closeET.getDay() === 0 || closeET.getDay() === 6) {
      closeET.setDate(closeET.getDate() + 1);
    }
  }
  const closeTime = new anchor.BN(Math.floor(closeET.getTime() / 1000));
  const today = new anchor.BN(Math.floor(Date.now() / 86400000));

  console.log(`Close time: ${closeET.toISOString()} (Unix: ${closeTime.toString()})`);

  for (const ticker of MAG7_TICKERS) {
    const refPrice = refPrices.get(ticker);
    if (!refPrice) {
      console.warn(`  No reference price for ${ticker}, skipping`);
      continue;
    }
    const strikes = generateStrikes(refPrice);
    console.log(`  ${ticker} ref=$${refPrice.toFixed(2)} -> strikes: ${strikes.map((s) => `$${s}`).join(", ")}`);

    for (const strikeDollars of strikes) {
      const strike = strikeDollars * USDC_PER_PAIR;
      const strikePrice = new anchor.BN(strike);
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

      // Initialize order book
      const [yesMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_mint"), marketPda.toBuffer()],
        program.programId
      );
      await withRetry(
        () => program.methods
          .initializeOrderBook()
          .accountsPartial({
            admin: admin.publicKey,
            market: marketPda,
            yesMint: yesMintPda,
            usdcMint,
          })
          .rpc(),
        `initializeOrderBook ${ticker} > $${strikeDollars}`
      );
      console.log(`    Created: ${ticker} > $${strikeDollars} + order book`);
      totalMarkets++;

      await sleep(DEVNET_DELAY_MS);
    }
  }

  // Write local-config.json for local testing against devnet
  const fs = await import("fs");
  const configPath = `${import.meta.dirname}/../app/src/lib/local-config.json`;
  fs.writeFileSync(
    configPath,
    JSON.stringify({ usdcMint: usdcMint.toString() }, null, 2)
  );

  console.log("\n=== Devnet Setup Complete ===");
  console.log(`USDC Mint: ${usdcMint.toString()}`);
  console.log(`Markets created: ${totalMarkets}`);
  console.log(`\nSet these Railway env vars:`);
  console.log(`  USDC_MINT=${usdcMint.toString()}`);
  console.log(`  ANCHOR_PROVIDER_URL=https://api.devnet.solana.com`);
  console.log(`  VITE_RPC_URL=https://api.devnet.solana.com`);
  console.log(`  VITE_USDC_MINT=${usdcMint.toString()}`);
  console.log(`  VITE_DEV_WALLET=true`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
