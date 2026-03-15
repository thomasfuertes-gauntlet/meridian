/**
 * Long-running CLOB order book seeder.
 * Loops every 15 min during market hours, discovers new markets,
 * and seeds any with empty order books. Idempotent per-market.
 *
 * Fetches live stock prices from Pyth Hermes, computes fair value
 * per market (sigmoid of distance-to-strike), and places logarithmic
 * depth centered around fair value.
 *
 * Uses deterministic bot-a wallet. Admin wallet mints USDC.
 */
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import { fairValue, computeLevels, fetchStockPrices, isMarketHours } from "./fair-value";
import { sleep, defaultTxDelay, isRemoteRpc } from "./bot-utils";
import { USDC_PER_PAIR } from "./constants";

const RESEED_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Check if a market's order book already has orders. */
async function isBookSeeded(connection: anchor.web3.Connection, marketPda: PublicKey, programId: PublicKey): Promise<boolean> {
  const [obPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook"), marketPda.toBuffer()],
    programId,
  );
  const obAccount = await connection.getAccountInfo(obPda);
  if (obAccount && obAccount.data.length >= 8 + 108) {
    const bidCount = obAccount.data.readUInt16LE(8 + 104);
    const askCount = obAccount.data.readUInt16LE(8 + 106);
    return bidCount + askCount > 0;
  }
  return false;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;
  const txDelayMs = defaultTxDelay();
  const isLocalhost = !isRemoteRpc();

  // Use deterministic dev wallets
  const bot = getDevWallet("bot-a");
  const admin = getDevWallet("admin"); // USDC mint authority

  console.log("Program ID:", program.programId.toString());
  console.log("Bot wallet (bot-a):", bot.publicKey.toString());
  console.log(`TX delay: ${txDelayMs}ms`);
  console.log("Ticker: NVDA");

  // Fund bot with SOL (only on localhost - devnet faucets rate-limit heavily)
  const botBal = await connection.getBalance(bot.publicKey);
  if (isLocalhost && botBal < 5 * LAMPORTS_PER_SOL) {
    const { SystemProgram, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: bot.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTransaction(connection, tx, [admin]);
    console.log("Transferred 10 SOL to bot from admin");
  } else {
    console.log(`Bot SOL balance: ${(botBal / LAMPORTS_PER_SOL).toFixed(2)} SOL`);
  }

  console.log(`Starting seed-bots loop (re-checks every ${RESEED_INTERVAL_MS / 60_000} min during market hours)\n`);

  // Long-running loop: discover and seed new markets every 15 min
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
    if (!isMarketHours()) {
      await sleep(RESEED_INTERVAL_MS);
      continue;
    }

    // Fetch live stock prices from Pyth Hermes
    const stockPrices = await fetchStockPrices();

    // Discover all active markets
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allMarkets = await (program.account as any).strikeMarket.all();
    const pendingMarkets = allMarkets.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m: any) => m.account.outcome?.pending !== undefined
    ).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m: any) => (m.account.ticker as string).toUpperCase() === "NVDA"
    );

    if (pendingMarkets.length === 0) {
      console.log("[seed] No active markets. Sleeping...");
      await sleep(RESEED_INTERVAL_MS);
      continue;
    }

    // Filter to only unseeded markets (per-market check)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unseededMarkets: any[] = [];
    for (const m of pendingMarkets) {
      const seeded = await isBookSeeded(connection, m.publicKey, program.programId);
      if (!seeded) unseededMarkets.push(m);
    }

    if (unseededMarkets.length === 0) {
      console.log(`[seed] All ${pendingMarkets.length} markets already seeded. Sleeping...`);
      await sleep(RESEED_INTERVAL_MS);
      continue;
    }

    console.log(`[seed] Found ${unseededMarkets.length} unseeded markets (of ${pendingMarkets.length} active)`);

    // Ensure USDC ATAs + funding for unseeded markets
    const usdcMints = Array.from(
      new Set(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        unseededMarkets.map((m: any) => m.account.usdcMint.toString())
      )
    ).map((mint) => new PublicKey(mint));

    const botUsdcAtas = new Map<string, PublicKey>();
    for (const usdcMint of usdcMints) {
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

      const botUsdcAccount = await getAccount(connection, botUsdcAta);
      const currentBalance = Number(botUsdcAccount.amount);
      const targetBalance = 40_000 * USDC_PER_PAIR;
      if (currentBalance < targetBalance) {
        await mintTo(connection, admin, usdcMint, botUsdcAta, admin, targetBalance - currentBalance);
        console.log(
          `Minted ${((targetBalance - currentBalance) / USDC_PER_PAIR).toLocaleString()} USDC to bot for mint ${usdcMint.toString()}`
        );
      }

      botUsdcAtas.set(usdcMint.toString(), botUsdcAta);
    }

    let seeded = 0;
    let failed = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of unseededMarkets) {
      const marketPda: PublicKey = m.publicKey;
      const ticker: string = m.account.ticker;
      const strikePrice: number = m.account.strikePrice.toNumber();
      const strikeDollars = strikePrice / USDC_PER_PAIR;
      const closeTime: number = m.account.closeTime.toNumber();
      const marketUsdcMint: PublicKey = m.account.usdcMint;
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

      const botUsdcAta = botUsdcAtas.get(marketUsdcMint.toString());
      if (!botUsdcAta) {
        throw new Error(`Missing bot USDC ATA for mint ${marketUsdcMint.toString()}`);
      }
      const botYesAta = getAssociatedTokenAddressSync(yesMintPda, bot.publicKey);
      const botNoAta = getAssociatedTokenAddressSync(noMintPda, bot.publicKey);

      // Ensure Yes/No ATAs exist before placing any orders (placeOrder validates both)
      const ataSetupTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(bot.publicKey, botYesAta, bot.publicKey, yesMintPda),
        createAssociatedTokenAccountIdempotentInstruction(bot.publicKey, botNoAta, bot.publicKey, noMintPda),
      );
      await anchor.web3.sendAndConfirmTransaction(connection, ataSetupTx, [bot]);
      await sleep(txDelayMs);

      // Total ask quantity needed for Yes token supply
      const totalAskQty = askLevels.reduce((sum, [, qty]) => sum + qty, 0);

      // Mint pairs to get Yes tokens for asks (also funds bids with USDC escrow)
      // Always mint at least 1 pair so bot has tokens for both sides
      const mintQty = Math.max(totalAskQty, 1);
      console.log(`  Minting ${mintQty} pairs...`);
      await program.methods
        .mintPair(new BN(mintQty))
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
      await sleep(txDelayMs);
      console.log(`  Minted ${mintQty} pairs`);

      // Place ask orders (sell Yes tokens at various prices)
      console.log("  Placing asks...");
      for (const [price, qty] of askLevels) {
        await program.methods
          .placeOrder({ ask: {} }, new BN(price), new BN(qty))
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
        await sleep(txDelayMs);
      }

      // Place bid orders (buy Yes tokens at various prices, escrows USDC)
      console.log("  Placing bids...");
      for (const [price, qty] of bidLevels) {
        await program.methods
          .placeOrder({ bid: {} }, new BN(price), new BN(qty))
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
        await sleep(txDelayMs);
      }

      console.log(`  Done: ${bidLevels.length} bids, ${askLevels.length} asks (${totalAskQty} depth/side)\n`);
      seeded++;
      } catch (err) {
        failed++;
        console.error(`  FAILED to seed ${ticker} > $${strikeDollars.toFixed(2)}: ${err instanceof Error ? err.message : err}\n`);
      }
    }

    console.log(`[seed] Round complete: ${seeded} seeded, ${failed} failed. Sleeping ${RESEED_INTERVAL_MS / 60_000} min...\n`);
    } catch (err) {
      console.error(`[seed] Loop iteration failed: ${err instanceof Error ? err.message : err}`);
      console.error("[seed] Will retry next interval...");
    }
    await sleep(RESEED_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
