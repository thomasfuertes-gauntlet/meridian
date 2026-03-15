/**
 * End-to-end UAT: prove the full Meridian lifecycle.
 * Creates markets, seeds books, trades, settles, redeems.
 * Exits 0 on success, 1 on failure.
 *
 * Uses past close times so admin_settle works immediately (no hour-long delay).
 * The on-chain admin_settle_delay_secs defaults to 3600s; update_config can
 * change it but this script avoids that dependency by setting closeTime far
 * enough in the past that now >= closeTime + 3600.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=http://localhost:8899 ANCHOR_WALLET=.wallets/admin.json \
 *     npx tsx scripts/uat.ts  # localnet auto-detected from ANCHOR_PROVIDER_URL
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
  getAccount,
} from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import { fetchStockPrices } from "./fair-value";
import { calculateStrikes } from "./strikes";

const USDC_DECIMALS = 6;
const USDC_PER_PAIR = 1_000_000;

// --- Result tracking ---
interface StepResult {
  name: string;
  passed: boolean;
  detail: string;
}
const results: StepResult[] = [];

function pass(name: string, detail: string) {
  results.push({ name, passed: true, detail });
  console.log(`  [PASS] ${name}: ${detail}`);
}

function fail(name: string, detail: string) {
  results.push({ name, passed: false, detail });
  console.error(`  [FAIL] ${name}: ${detail}`);
}

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
  const connection = provider.connection;

  const adminKeypair = getDevWallet("admin");
  const botA = getDevWallet("bot-a");
  const botB = getDevWallet("bot-b");

  const ticker = (process.env.DEMO_TICKER || "NVDA").trim().toUpperCase();

  console.log("=== Meridian UAT ===");
  console.log(`Program: ${program.programId.toString()}`);
  console.log(`Admin: ${adminKeypair.publicKey.toString()}`);
  console.log(`Bot-A: ${botA.publicKey.toString()}`);
  console.log(`Bot-B: ${botB.publicKey.toString()}`);
  console.log(`Ticker: ${ticker}`);
  console.log();

  // =========================================================================
  // Step 1: Setup
  // =========================================================================
  console.log("[1/7] Setup: SOL funding, USDC mint, wallet funding, config...");
  let usdcMint: PublicKey;

  try {
    // Fund admin with SOL if needed (local validator mints to admin via --mint,
    // so airdrop is only needed in anchor-test environments with faucet enabled)
    const adminBalance = await connection.getBalance(adminKeypair.publicKey);
    if (adminBalance < 10 * LAMPORTS_PER_SOL) {
      try {
        const sig = await connection.requestAirdrop(
          adminKeypair.publicKey,
          10 * LAMPORTS_PER_SOL
        );
        await connection.confirmTransaction(sig, "confirmed");
      } catch {
        // Faucet disabled (--faucet-port 0) - admin should already be funded via --mint
        if (adminBalance < LAMPORTS_PER_SOL) {
          throw new Error(`Admin has only ${adminBalance / LAMPORTS_PER_SOL} SOL and faucet is unavailable`);
        }
      }
    }

    // Create USDC mint
    usdcMint = await createMint(
      connection,
      adminKeypair,
      adminKeypair.publicKey,
      null,
      USDC_DECIMALS
    );

    // Fund admin with USDC
    const adminUsdcAta = await createAssociatedTokenAccount(
      connection,
      adminKeypair,
      usdcMint,
      adminKeypair.publicKey
    );
    await mintTo(
      connection,
      adminKeypair,
      usdcMint,
      adminUsdcAta,
      adminKeypair,
      1000 * USDC_PER_PAIR
    );

    // Fund bot-a: SOL + USDC
    const txA = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: adminKeypair.publicKey,
        toPubkey: botA.publicKey,
        lamports: 5 * LAMPORTS_PER_SOL,
      })
    );
    await anchor.web3.sendAndConfirmTransaction(connection, txA, [adminKeypair]);

    const botAUsdcAta = getAssociatedTokenAddressSync(usdcMint, botA.publicKey);
    const createBotAAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      adminKeypair.publicKey,
      botAUsdcAta,
      botA.publicKey,
      usdcMint
    );
    const botAAtaTx = new Transaction().add(createBotAAtaIx);
    await anchor.web3.sendAndConfirmTransaction(connection, botAAtaTx, [
      adminKeypair,
    ]);
    await mintTo(
      connection,
      adminKeypair,
      usdcMint,
      botAUsdcAta,
      adminKeypair,
      1000 * USDC_PER_PAIR
    );

    // Fund bot-b: SOL + USDC
    const txB = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: adminKeypair.publicKey,
        toPubkey: botB.publicKey,
        lamports: 5 * LAMPORTS_PER_SOL,
      })
    );
    await anchor.web3.sendAndConfirmTransaction(connection, txB, [adminKeypair]);

    const botBUsdcAta = getAssociatedTokenAddressSync(usdcMint, botB.publicKey);
    const createBotBAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      adminKeypair.publicKey,
      botBUsdcAta,
      botB.publicKey,
      usdcMint
    );
    const botBAtaTx = new Transaction().add(createBotBAtaIx);
    await anchor.web3.sendAndConfirmTransaction(connection, botBAtaTx, [
      adminKeypair,
    ]);
    await mintTo(
      connection,
      adminKeypair,
      usdcMint,
      botBUsdcAta,
      adminKeypair,
      1000 * USDC_PER_PAIR
    );

    // Initialize config
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    if (!(await accountExists(connection, configPda))) {
      await program.methods
        .initializeConfig()
        .accountsPartial({ admin: adminKeypair.publicKey })
        .rpc();
    }

    pass("Setup", "USDC mint + wallets funded + config initialized");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("Setup", msg.slice(0, 200));
    printReport();
    process.exit(1);
  }

  // =========================================================================
  // Step 2: Create markets
  // =========================================================================
  console.log("\n[2/7] Create markets...");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let markets: any[] = [];
  try {
    // Use past close time so admin_settle works immediately.
    // admin_settle requires: now >= close_time + admin_settle_delay_secs (3600).
    // On-chain requires: close_time > date.
    // Setting date = now - 86400 (yesterday), close_time = now - 7200 (2hrs ago):
    //   close_time > date: (now-7200) > (now-86400) ✓
    //   admin_settle eligible: now >= (now-7200) + 3600 = now - 3600 ✓
    const nowSecs = Math.floor(Date.now() / 1000);
    const dateSeed = new BN(nowSecs - 86400);
    const closeTime = new BN(nowSecs - 7200);

    const stockPrices = await fetchStockPrices();
    const refPrice = stockPrices.get(ticker);
    if (!refPrice) {
      throw new Error(`No reference price for ${ticker}`);
    }

    const strikes = calculateStrikes(refPrice);
    let created = 0;

    for (const strikeDollars of strikes) {
      const strikePrice = new BN(strikeDollars * USDC_PER_PAIR);
      const [marketPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("market"),
          Buffer.from(ticker),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (strikePrice as any).toArrayLike(Buffer, "le", 8),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (dateSeed as any).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      if (await accountExists(connection, marketPda)) {
        created++;
        continue;
      }

      await program.methods
        .createStrikeMarket(ticker, strikePrice, dateSeed, closeTime)
        .accountsPartial({ admin: adminKeypair.publicKey, usdcMint: usdcMint! })
        .rpc();
      created++;
    }

    // Fetch all markets for this ticker
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allMarkets = await (program.account as any).strikeMarket.all();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markets = allMarkets.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m: any) => (m.account.ticker as string).toUpperCase() === ticker
    );

    pass("Markets", `${created} markets created for ${ticker}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("Markets", msg.slice(0, 200));
    printReport();
    process.exit(1);
  }

  // =========================================================================
  // Step 3: Mint pairs (bot-b mints 10 pairs on the first market)
  // =========================================================================
  console.log("\n[3/7] Mint pairs...");

  const market = markets[0];
  const marketPda: PublicKey = market.publicKey;
  const marketAccount = market.account;

  // Derive PDAs for the market
  const yesMint = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_mint"), marketPda.toBuffer()],
    program.programId
  )[0];
  const noMint = PublicKey.findProgramAddressSync(
    [Buffer.from("no_mint"), marketPda.toBuffer()],
    program.programId
  )[0];
  const vault = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPda.toBuffer()],
    program.programId
  )[0];
  const orderBookPda = PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook"), marketPda.toBuffer()],
    program.programId
  )[0];
  const obUsdcVault = PublicKey.findProgramAddressSync(
    [Buffer.from("ob_usdc_vault"), marketPda.toBuffer()],
    program.programId
  )[0];
  const obYesVault = PublicKey.findProgramAddressSync(
    [Buffer.from("ob_yes_vault"), marketPda.toBuffer()],
    program.programId
  )[0];

  try {
    // mintPair has init_if_needed for yes/no ATAs, so they're auto-created
    const botBUsdc = getAssociatedTokenAddressSync(usdcMint!, botB.publicKey);

    await program.methods
      .mintPair(new BN(10))
      .accountsPartial({
        user: botB.publicKey,
        market: marketPda,
        userUsdc: botBUsdc,
        vault,
        yesMint,
        noMint,
      })
      .signers([botB])
      .rpc();

    // Verify token balances
    const botBYesAta = getAssociatedTokenAddressSync(yesMint, botB.publicKey);
    const botBNoAta = getAssociatedTokenAddressSync(noMint, botB.publicKey);
    const yesAccount = await getAccount(connection, botBYesAta);
    const noAccount = await getAccount(connection, botBNoAta);

    if (yesAccount.amount !== 10n || noAccount.amount !== 10n) {
      throw new Error(
        `Expected 10 yes + 10 no, got ${yesAccount.amount} yes + ${noAccount.amount} no`
      );
    }

    pass("Mint", "10 pairs minted for bot-b (10 yes + 10 no)");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("Mint", msg.slice(0, 200));
    printReport();
    process.exit(1);
  }

  // =========================================================================
  // Step 4: Place order + trade
  // =========================================================================
  console.log("\n[4/7] Place order + trade...");

  try {
    const botAUsdc = getAssociatedTokenAddressSync(usdcMint!, botA.publicKey);

    // bot-a mints 10 pairs too (needs yes tokens to place an ask)
    await program.methods
      .mintPair(new BN(10))
      .accountsPartial({
        user: botA.publicKey,
        market: marketPda,
        userUsdc: botAUsdc,
        vault,
        yesMint,
        noMint,
      })
      .signers([botA])
      .rpc();

    // bot-a places a limit ask (sell 5 yes at $0.60)
    const botAYesAta = getAssociatedTokenAddressSync(yesMint, botA.publicKey);

    await program.methods
      .placeOrder({ ask: {} }, new BN(600_000), new BN(5))
      .accountsPartial({
        user: botA.publicKey,
        market: marketPda,
        orderBook: orderBookPda,
        obUsdcVault,
        obYesVault,
        userUsdc: botAUsdc,
        userYes: botAYesAta,
      })
      .signers([botA])
      .rpc();

    // Record bot-b's yes balance before buy
    const botBYesAta = getAssociatedTokenAddressSync(yesMint, botB.publicKey);
    const beforeBuy = await getAccount(connection, botBYesAta);
    const yesBefore = beforeBuy.amount;

    // bot-b buys 5 yes at max price $0.70
    const botBUsdc = getAssociatedTokenAddressSync(usdcMint!, botB.publicKey);

    await program.methods
      .buyYes(new BN(5), new BN(700_000))
      .accountsPartial({
        user: botB.publicKey,
        market: marketPda,
        userUsdc: botBUsdc,
        yesMint,
        userYes: botBYesAta,
        orderBook: orderBookPda,
        obUsdcVault,
        obYesVault,
      })
      .signers([botB])
      .rpc();

    // Verify bot-b gained 5 yes tokens
    const afterBuy = await getAccount(connection, botBYesAta);
    const yesGained = afterBuy.amount - yesBefore;

    if (yesGained !== 5n) {
      throw new Error(`Expected to gain 5 yes tokens, got ${yesGained}`);
    }

    pass("Trade", `5 yes tokens traded at $0.60 (bot-b gained ${yesGained})`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("Trade", msg.slice(0, 200));
    printReport();
    process.exit(1);
  }

  // =========================================================================
  // Step 5: Settle (admin_settle with synthetic price -> YesWins)
  // =========================================================================
  console.log("\n[5/7] Settle market...");

  try {
    // Close time is in the past and delay is already satisfied, settle immediately.
    const syntheticPrice = marketAccount.strikePrice.toNumber() + 1_000_000;

    await program.methods
      .adminSettle(new BN(syntheticPrice))
      .accountsPartial({
        admin: adminKeypair.publicKey,
        market: marketPda,
      })
      .remainingAccounts([
        { pubkey: orderBookPda, isSigner: false, isWritable: true },
      ])
      .signers([adminKeypair])
      .rpc();

    // Verify outcome
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settled = await (program.account as any).strikeMarket.fetch(marketPda);
    const outcomeKey = Object.keys(settled.outcome)[0];

    if (outcomeKey !== "yesWins") {
      throw new Error(`Expected YesWins outcome, got ${outcomeKey}`);
    }

    pass("Settle", `Market settled YesWins (price=$${(syntheticPrice / USDC_PER_PAIR).toFixed(2)})`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("Settle", msg.slice(0, 200));
    printReport();
    process.exit(1);
  }

  // =========================================================================
  // Step 6: Redeem (bot-b redeems winning yes tokens for USDC)
  // =========================================================================
  console.log("\n[6/7] Redeem yes tokens...");

  try {
    const botBUsdc = getAssociatedTokenAddressSync(usdcMint!, botB.publicKey);
    const botBYesAta = getAssociatedTokenAddressSync(yesMint, botB.publicKey);

    // Check balances before redeem
    const usdcBefore = (await getAccount(connection, botBUsdc)).amount;
    const yesBalance = (await getAccount(connection, botBYesAta)).amount;

    if (yesBalance === 0n) {
      throw new Error("bot-b has 0 yes tokens to redeem");
    }

    // Redeem uses tokenMint + userToken (not yesMint/noMint/userYes/userNo)
    await program.methods
      .redeem(new BN(Number(yesBalance)))
      .accountsPartial({
        user: botB.publicKey,
        market: marketPda,
        userUsdc: botBUsdc,
        vault,
        tokenMint: yesMint,
        userToken: botBYesAta,
      })
      .signers([botB])
      .rpc();

    // Verify USDC received
    const usdcAfter = (await getAccount(connection, botBUsdc)).amount;
    const usdcGained = usdcAfter - usdcBefore;
    const expectedUsdc = yesBalance * BigInt(USDC_PER_PAIR);

    if (usdcGained !== expectedUsdc) {
      throw new Error(
        `Expected ${expectedUsdc} USDC, got ${usdcGained}`
      );
    }

    pass(
      "Redeem",
      `${yesBalance} yes tokens redeemed for ${Number(usdcGained) / USDC_PER_PAIR} USDC`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("Redeem", msg.slice(0, 200));
  }

  // =========================================================================
  // Step 7: Claim fills (bot-a claims USDC credits from the CLOB)
  // =========================================================================
  console.log("\n[7/7] Claim fills (bot-a)...");

  try {
    const botAUsdc = getAssociatedTokenAddressSync(usdcMint!, botA.publicKey);
    const botAYes = getAssociatedTokenAddressSync(yesMint, botA.publicKey);
    const usdcBefore = (await getAccount(connection, botAUsdc)).amount;

    await program.methods
      .claimFills()
      .accountsPartial({
        payer: botA.publicKey,
        market: marketPda,
        orderBook: orderBookPda,
        obUsdcVault,
        obYesVault,
        owner: botA.publicKey,
        ownerUsdc: botAUsdc,
        ownerYes: botAYes,
      })
      .signers([botA])
      .rpc();

    const usdcAfter = (await getAccount(connection, botAUsdc)).amount;
    const claimed = usdcAfter - usdcBefore;

    pass(
      "Claim fills",
      `bot-a claimed ${Number(claimed) / USDC_PER_PAIR} USDC from CLOB credits`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("Claim fills", msg.slice(0, 200));
  }

  // =========================================================================
  // Report
  // =========================================================================
  printReport();
  const anyFailed = results.some((r) => !r.passed);
  process.exit(anyFailed ? 1 : 0);
}

function printReport() {
  console.log("\n=== UAT Results ===");
  for (const r of results) {
    const icon = r.passed ? "\u2713" : "\u2717";
    console.log(`${icon} ${r.name}: ${r.detail}`);
  }
  console.log();
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  if (passed === total) {
    console.log(`All ${total} checks passed.`);
  } else {
    console.log(`${passed}/${total} checks passed, ${total - passed} failed.`);
  }
}

main().catch((err) => {
  console.error("UAT crashed:", err);
  process.exit(1);
});
