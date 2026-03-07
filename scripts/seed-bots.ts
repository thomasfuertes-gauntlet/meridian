/**
 * Seed CLOB order books with bot liquidity.
 * Run after `make setup` (needs local-config.json with USDC mint).
 *
 * Uses deterministic bot-a wallet. For each market: mints pairs to get
 * Yes tokens, then places resting bids and asks.
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

const USDC_PER_PAIR = 1_000_000;

// Price levels centered around 0.50 - bids below, asks above
// Each level: [price_usdc_units, quantity]
const BID_LEVELS: [number, number][] = [
  [480_000, 3],  // 0.48
  [450_000, 5],  // 0.45
  [420_000, 4],  // 0.42
  [380_000, 6],  // 0.38
  [350_000, 8],  // 0.35
  [300_000, 10], // 0.30
];

const ASK_LEVELS: [number, number][] = [
  [520_000, 3],  // 0.52
  [550_000, 5],  // 0.55
  [580_000, 4],  // 0.58
  [620_000, 6],  // 0.62
  [650_000, 8],  // 0.65
  [700_000, 10], // 0.70
];

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;

  // Load USDC mint from local-config
  const configPath = path.join(__dirname, "../app/src/lib/local-config.json");
  if (!fs.existsSync(configPath)) {
    console.error("local-config.json not found. Run `make setup` first.");
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const usdcMint = new PublicKey(config.usdcMint);

  // Use deterministic bot-a wallet
  const bot = getDevWallet("bot-a");
  const admin = getDevWallet("admin"); // admin is USDC mint authority

  console.log("USDC Mint:", usdcMint.toString());
  console.log("Program ID:", program.programId.toString());
  console.log("Bot wallet (bot-a):", bot.publicKey.toString());

  // Fund bot with SOL
  const botBal = await connection.getBalance(bot.publicKey);
  if (botBal < 5 * LAMPORTS_PER_SOL) {
    const airdropSig = await connection.requestAirdrop(bot.publicKey, 10 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig);
    console.log("Airdropped 10 SOL to bot");
  }

  // Create bot USDC ATA and mint USDC
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

  await mintTo(connection, admin, usdcMint, botUsdcAta, admin, 500 * USDC_PER_PAIR);
  console.log("Minted 500 USDC to bot");

  // Fetch all markets
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  const pendingMarkets = allMarkets.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m: any) => m.account.outcome?.pending !== undefined
  );
  console.log(`Found ${pendingMarkets.length} active markets\n`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of pendingMarkets) {
    const marketPda: PublicKey = m.publicKey;
    const ticker: string = m.account.ticker;
    const strikePrice: number = m.account.strikePrice.toNumber();
    console.log(`--- ${ticker} > $${(strikePrice / USDC_PER_PAIR).toFixed(2)} ---`);

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

    // Total ask quantity needed
    const totalAskQty = ASK_LEVELS.reduce((sum, [, qty]) => sum + qty, 0);

    // Mint pairs to get Yes tokens for asks (mint_pair creates ATAs via init_if_needed)
    console.log(`  Minting ${totalAskQty} pairs...`);
    const BATCH_SIZE = 6;
    for (let i = 0; i < totalAskQty; i += BATCH_SIZE) {
      const tx = new anchor.web3.Transaction();
      const batchEnd = Math.min(i + BATCH_SIZE, totalAskQty);
      for (let j = i; j < batchEnd; j++) {
        const ix = await program.methods
          .mintPair()
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
          .instruction();
        tx.add(ix);
      }
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [bot]);
    }
    console.log(`  Minted ${totalAskQty} pairs`);

    // Place ask orders (sell Yes tokens at various prices)
    console.log("  Placing asks...");
    for (const [price, qty] of ASK_LEVELS) {
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
    }

    // Place bid orders (buy Yes tokens at various prices, escrows USDC)
    console.log("  Placing bids...");
    for (const [price, qty] of BID_LEVELS) {
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
    }

    console.log(`  Done: ${BID_LEVELS.length} bids, ${ASK_LEVELS.length} asks\n`);
  }

  console.log("--- Bot seeding complete ---");
  console.log("Run `make live` to start live trading bot");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
