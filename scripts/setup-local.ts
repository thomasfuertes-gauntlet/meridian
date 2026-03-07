/**
 * Local development setup script.
 * Run after `anchor deploy` on local validator.
 * Idempotent - safe to run multiple times.
 *
 * Creates: config, USDC mint, 7 test markets (one per MAG7 stock),
 * order books, and airdrops USDC to a specified wallet.
 *
 * Uses deterministic dev wallets from scripts/dev-wallets.ts.
 * Admin wallet is both program admin and USDC mint authority.
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

const MAG7_STRIKES: { ticker: string; strike: number }[] = [
  { ticker: "AAPL", strike: 230_000_000 },
  { ticker: "MSFT", strike: 420_000_000 },
  { ticker: "GOOGL", strike: 180_000_000 },
  { ticker: "AMZN", strike: 200_000_000 },
  { ticker: "NVDA", strike: 130_000_000 },
  { ticker: "META", strike: 680_000_000 },
  { ticker: "TSLA", strike: 250_000_000 },
];

const USDC_DECIMALS = 6;
const USDC_PER_PAIR = 1_000_000;
// Dummy Pyth feed ID (32 zero bytes) - local validator has no Pyth
const dummyPythFeedId = Array(32).fill(0);
// close_time = 0 so admin_settle works (0 + 3600 < any real clock)
const pastCloseTime = new anchor.BN(0);
const today = new anchor.BN(Math.floor(Date.now() / 86400000));

async function accountExists(
  connection: anchor.web3.Connection,
  pubkey: PublicKey
): Promise<boolean> {
  const info = await connection.getAccountInfo(pubkey);
  return info !== null;
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

  // Fund admin keypair for mint operations (provider.wallet and adminKeypair are the same key,
  // but the provider wallet is loaded from file by Anchor - we need the Keypair for signing)
  const adminBal = await connection.getBalance(adminKeypair.publicKey);
  if (adminBal < 2 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(adminKeypair.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  }

  // Optional: fund a browser wallet (pass pubkey as CLI arg)
  const browserWallet = process.argv[2] ? new PublicKey(process.argv[2]) : null;
  if (browserWallet) {
    console.log("Browser wallet:", browserWallet.toString());
    const sig = await connection.requestAirdrop(browserWallet, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    console.log("Airdropped 5 SOL to browser wallet");
  }

  // Fund bot-b for frontend auto-sign
  const botBBal = await connection.getBalance(botB.publicKey);
  if (botBBal < 2 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(botB.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    console.log("Funded bot-b (frontend auto-sign):", botB.publicKey.toString());
  }

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

  // 6. Create markets + order books for each MAG7 stock
  for (const { ticker, strike } of MAG7_STRIKES) {
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

    // Skip if market already exists
    if (await accountExists(connection, marketPda)) {
      console.log(`Market already exists: ${ticker} > $${strike / USDC_PER_PAIR}, skipping`);
      continue;
    }

    await program.methods
      .createStrikeMarket(ticker, strikePrice, today, pastCloseTime, dummyPythFeedId)
      .accountsPartial({ admin: admin.publicKey, usdcMint })
      .rpc();
    console.log(`Created market: ${ticker} > $${strike / USDC_PER_PAIR}`);

    // Initialize order book
    const [yesMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_mint"), marketPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeOrderBook()
      .accountsPartial({
        admin: admin.publicKey,
        market: marketPda,
        yesMint: yesMintPda,
        usdcMint,
      })
      .rpc();
    console.log(`  Order book initialized for ${ticker}`);
  }

  // Write config for frontend + bot scripts
  const fs = await import("fs");
  const configPath = `${__dirname}/../app/src/lib/local-config.json`;
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
  console.log(`Markets created: ${MAG7_STRIKES.length}`);
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
