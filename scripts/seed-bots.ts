/**
 * Seed CLOB order books with oracle-anchored liquidity.
 * Run after `make setup` (needs local-config.json with USDC mint).
 *
 * Fetches live stock prices from Pyth Hermes, computes fair value
 * per market (sigmoid of distance-to-strike), and places logarithmic
 * depth centered around fair value.
 *
 * Uses deterministic bot-a wallet. Admin wallet mints USDC.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { getDevWallet } from "./dev-wallets";
import { fairValue, computeLevels, fetchStockPrices } from "./fair-value";

const USDC_PER_PAIR = 1_000_000;
const TX_DELAY_MS = 1200; // throttle for devnet/Helius rate limits (1 tx/s free tier)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;

  // Load USDC mint from env var or local-config.json
  let usdcMintStr = process.env.USDC_MINT;
  if (!usdcMintStr) {
    const configPath = path.join(import.meta.dirname, "../app/src/lib/local-config.json");
    if (!fs.existsSync(configPath)) {
      console.error("USDC mint not found. Set USDC_MINT env var or run `make setup`.");
      process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    usdcMintStr = config.usdcMint;
  }
  const usdcMint = new PublicKey(usdcMintStr!);

  // Use deterministic dev wallets
  const bot = getDevWallet("bot-a");
  const admin = getDevWallet("admin"); // USDC mint authority

  console.log("USDC Mint:", usdcMint.toString());
  console.log("Program ID:", program.programId.toString());
  console.log("Bot wallet (bot-a):", bot.publicKey.toString());

  // Fund bot with SOL (only on localhost - devnet faucets rate-limit heavily)
  const botBal = await connection.getBalance(bot.publicKey);
  const isLocalhost = connection.rpcEndpoint.includes("localhost") || connection.rpcEndpoint.includes("127.0.0.1");
  if (isLocalhost && botBal < 5 * LAMPORTS_PER_SOL) {
    const airdropSig = await connection.requestAirdrop(bot.publicKey, 10 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig);
    console.log("Airdropped 10 SOL to bot");
  } else {
    console.log(`Bot SOL balance: ${(botBal / LAMPORTS_PER_SOL).toFixed(2)} SOL`);
  }

  // Create bot USDC ATA and mint USDC (10,000 for deep liquidity)
  const botUsdcAta = getAssociatedTokenAddressSync(usdcMint, bot.publicKey);
  const createAtaTx = new anchor.web3.Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      bot.publicKey,
      botUsdcAta,
      bot.publicKey,
      usdcMint,
    )
  );
  await anchor.web3.sendAndConfirmTransaction(connection, createAtaTx, [bot]);

  await mintTo(connection, admin, usdcMint, botUsdcAta, admin, 20_000 * USDC_PER_PAIR);
  console.log("Minted 20,000 USDC to bot");

  // Fetch live stock prices from Pyth Hermes
  console.log("Fetching stock prices from Pyth Hermes...");
  const stockPrices = await fetchStockPrices();
  stockPrices.forEach((price, ticker) => {
    console.log(`  ${ticker}: $${price.toFixed(2)}`);
  });
  if (stockPrices.size === 0) {
    console.log("  (no prices available)");
  }

  // Fetch all markets
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  const pendingMarkets = allMarkets.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m: any) => m.account.outcome?.pending !== undefined
  );
  console.log(`Found ${pendingMarkets.length} active markets\n`);

  // Auto-skip if order books already have orders (idempotent seeding)
  if (pendingMarkets.length > 0) {
    const sampleMarket = pendingMarkets[0].publicKey;
    const [sampleOb] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), sampleMarket.toBuffer()],
      program.programId,
    );
    const obAccount = await connection.getAccountInfo(sampleOb);
    if (obAccount && obAccount.data.length >= 8 + 108) {
      // bid_count at offset 8+104, ask_count at offset 8+106 (discriminator + header)
      const bidCount = obAccount.data.readUInt16LE(8 + 104);
      const askCount = obAccount.data.readUInt16LE(8 + 106);
      if (bidCount + askCount > 0) {
        console.log(`Order books already seeded (${bidCount} bids, ${askCount} asks on first market). Skipping.`);
        return;
      }
    }
  }

  let seeded = 0;
  let failed = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of pendingMarkets) {
    const marketPda: PublicKey = m.publicKey;
    const ticker: string = m.account.ticker;
    const strikePrice: number = m.account.strikePrice.toNumber();
    const strikeDollars = strikePrice / USDC_PER_PAIR;
    const closeTime: number = m.account.closeTime.toNumber();
    const hoursUntilClose = (closeTime - Date.now() / 1000) / 3600;

    // Compute fair value from oracle price
    const stockPrice = stockPrices.get(ticker);
    const fair = stockPrice ? fairValue(stockPrice, strikeDollars, hoursUntilClose) : 0.50;
    const { bids: bidLevels, asks: askLevels } = computeLevels(fair);

    console.log(`--- ${ticker} > $${strikeDollars.toFixed(2)} (fair: $${fair.toFixed(2)}) ---`);

    try { // per-market error isolation

    const [yesMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_mint"), marketPda.toBuffer()],
      program.programId,
    );
    const [noMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("no_mint"), marketPda.toBuffer()],
      program.programId,
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId,
    );
    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), marketPda.toBuffer()],
      program.programId,
    );
    const [obUsdcVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("ob_usdc_vault"), marketPda.toBuffer()],
      program.programId,
    );
    const [obYesVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("ob_yes_vault"), marketPda.toBuffer()],
      program.programId,
    );

    const botYesAta = getAssociatedTokenAddressSync(yesMintPda, bot.publicKey);
    const botNoAta = getAssociatedTokenAddressSync(noMintPda, bot.publicKey);

    // Ensure Yes/No ATAs exist before placing any orders (placeOrder validates both)
    const ataSetupTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(bot.publicKey, botYesAta, bot.publicKey, yesMintPda),
      createAssociatedTokenAccountIdempotentInstruction(bot.publicKey, botNoAta, bot.publicKey, noMintPda),
    );
    await anchor.web3.sendAndConfirmTransaction(connection, ataSetupTx, [bot]);
    await sleep(TX_DELAY_MS);

    // Total ask quantity needed for Yes token supply
    const totalAskQty = askLevels.reduce((sum, [, qty]) => sum + qty, 0);

    // Mint pairs to get Yes tokens for asks (also funds bids with USDC escrow)
    // Always mint at least 1 pair so bot has tokens for both sides
    const mintQty = Math.max(totalAskQty, 1);
    console.log(`  Minting ${mintQty} pairs...`);
    await program.methods
      .mintPair(new anchor.BN(mintQty))
      .accountsPartial({
        user: bot.publicKey,
        market: marketPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        vault,
        userUsdc: botUsdcAta,
        userYes: botYesAta,
        userNo: botNoAta,
      })
      .signers([bot])
      .rpc();
    await sleep(TX_DELAY_MS);
    console.log(`  Minted ${mintQty} pairs`);

    // Place ask orders (sell Yes tokens at various prices)
    console.log("  Placing asks...");
    for (const [price, qty] of askLevels) {
      await program.methods
        .placeOrder({ ask: {} }, new anchor.BN(price), new anchor.BN(qty))
        .accountsPartial({
          user: bot.publicKey,
          market: marketPda,
          orderBook: orderBookPda,
          obUsdcVault,
          obYesVault,
          userUsdc: botUsdcAta,
          userYes: botYesAta,
        })
        .signers([bot])
        .rpc();
      console.log(`    Ask: ${qty} @ $${(price / USDC_PER_PAIR).toFixed(2)}`);
      await sleep(TX_DELAY_MS);
    }

    // Place bid orders (buy Yes tokens at various prices, escrows USDC)
    console.log("  Placing bids...");
    for (const [price, qty] of bidLevels) {
      await program.methods
        .placeOrder({ bid: {} }, new anchor.BN(price), new anchor.BN(qty))
        .accountsPartial({
          user: bot.publicKey,
          market: marketPda,
          orderBook: orderBookPda,
          obUsdcVault,
          obYesVault,
          userUsdc: botUsdcAta,
          userYes: botYesAta,
        })
        .signers([bot])
        .rpc();
      console.log(`    Bid: ${qty} @ $${(price / USDC_PER_PAIR).toFixed(2)}`);
      await sleep(TX_DELAY_MS);
    }

    console.log(`  Done: ${bidLevels.length} bids, ${askLevels.length} asks (${totalAskQty} depth/side)\n`);
    seeded++;
    } catch (err) {
      failed++;
      console.error(`  FAILED to seed ${ticker} > $${strikeDollars.toFixed(2)}: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  console.log(`--- Bot seeding complete: ${seeded} markets seeded, ${failed} failed ---`);
  console.log("Run `make live` to start live trading bot");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
