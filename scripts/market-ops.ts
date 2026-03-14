/**
 * Shared market operations for Meridian scripts.
 * Consolidates settle/close/create logic from alpha-cycle, alpha-settle,
 * smart-deploy, setup-local, and setup-devnet.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Meridian } from "../target/types/meridian";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { getDevWallet } from "./dev-wallets";
import { USDC_PER_PAIR, USDC_DECIMALS, MAG7_TICKERS } from "./constants";
import { isRemoteRpc, sleep } from "./bot-utils";
import { calculateStrikes } from "./strikes";
import { fetchStockPrices } from "./fair-value";

const TX_DELAY = () => (isRemoteRpc() ? 1500 : 0);

// --- Utility helpers ---

export async function accountExists(
  connection: anchor.web3.Connection,
  pubkey: PublicKey,
): Promise<boolean> {
  const info = await connection.getAccountInfo(pubkey);
  return info !== null;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 3,
  baseDelay = 1500,
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === retries - 1) throw err;
      const delay = baseDelay * (i + 1);
      console.log(`    Retry ${i + 1}/${retries} for ${label} (${delay}ms): ${msg.slice(0, 80)}`);
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}

export async function ensureSolBalance(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  recipient: PublicKey,
  minimumLamports: number,
  targetLamports: number,
): Promise<void> {
  const balance = await connection.getBalance(recipient);
  if (balance >= minimumLamports) return;
  const lamports = Math.max(0, targetLamports - balance);
  if (lamports === 0) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports }),
  );
  await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer]);
}

// --- Config operations ---

export async function ensureGlobalConfig(
  program: Program<Meridian>,
  connection: anchor.web3.Connection,
  admin: PublicKey,
): Promise<void> {
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  if (await accountExists(connection, configPda)) {
    console.log("  Config exists.");
    return;
  }
  await program.methods.initializeConfig().accountsPartial({ admin }).rpc();
  console.log("  Config initialized.");
}

export async function updateConfigDelay(
  program: Program<Meridian>,
  admin: PublicKey,
  delaySecs: number,
): Promise<void> {
  await program.methods
    .updateConfig(new BN(delaySecs))
    .accountsPartial({ admin })
    .rpc();
  console.log(`  Config updated: admin_settle_delay_secs = ${delaySecs}`);
}

// --- USDC + wallet setup ---

/**
 * Idempotent USDC mint creation. If local-config.json already has a valid mint
 * that exists on-chain, returns it. Otherwise creates a new mint and writes config.
 */
export async function ensureUsdcMint(
  connection: anchor.web3.Connection,
  admin: anchor.web3.Keypair,
): Promise<PublicKey> {
  const configPath = path.join(
    import.meta.dirname,
    "..",
    "frontend",
    "src",
    "lib",
    "local-config.json",
  );

  // Check if existing mint is still valid
  try {
    const existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (existing.usdcMint) {
      const mint = new PublicKey(existing.usdcMint);
      if (await accountExists(connection, mint)) {
        console.log(`  USDC mint exists: ${mint.toString()}`);
        return mint;
      }
    }
  } catch {
    // File doesn't exist or invalid - create new mint
  }

  const usdcMint = await createMint(connection, admin, admin.publicKey, null, USDC_DECIMALS);
  console.log(`  Created USDC mint: ${usdcMint.toString()}`);

  // Write config for frontend + bot scripts
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ usdcMint: usdcMint.toString() }, null, 2));
  console.log(`  Wrote ${configPath}`);

  return usdcMint;
}

/**
 * Fund dev wallets (bot-a, bot-b) with SOL and USDC. Idempotent.
 * Also mints USDC to admin if needed.
 */
export async function fundDevWallets(
  connection: anchor.web3.Connection,
  admin: anchor.web3.Keypair,
  usdcMint: PublicKey,
  opts: { adminUsdc?: number; botUsdc?: number; solPerBot?: number } = {},
): Promise<void> {
  const { adminUsdc = 1000, botUsdc = 250_000, solPerBot = 5 } = opts;
  const botA = getDevWallet("bot-a");
  const botB = getDevWallet("bot-b");

  // Fund bots with SOL
  for (const [name, kp] of [
    ["bot-a", botA],
    ["bot-b", botB],
  ] as const) {
    await ensureSolBalance(
      connection,
      admin,
      kp.publicKey,
      2 * LAMPORTS_PER_SOL,
      solPerBot * LAMPORTS_PER_SOL,
    );
    console.log(`  ${name}: ${kp.publicKey.toString()} - ${solPerBot} SOL`);
  }

  // Admin USDC ATA + mint
  const adminAta = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
  if (!(await accountExists(connection, adminAta))) {
    await createAssociatedTokenAccount(connection, admin, usdcMint, admin.publicKey);
    await mintTo(connection, admin, usdcMint, adminAta, admin, adminUsdc * USDC_PER_PAIR);
    console.log(`  Admin: minted ${adminUsdc} USDC`);
  }

  // Bot USDC ATAs + mint
  for (const [name, kp] of [
    ["bot-a", botA],
    ["bot-b", botB],
  ] as const) {
    const ata = getAssociatedTokenAddressSync(usdcMint, kp.publicKey);
    if (!(await accountExists(connection, ata))) {
      const ix = createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey,
        ata,
        kp.publicKey,
        usdcMint,
      );
      const tx = new Transaction().add(ix);
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [admin]);
      await mintTo(connection, admin, usdcMint, ata, admin, botUsdc * USDC_PER_PAIR);
      console.log(`  ${name}: minted ${botUsdc.toLocaleString()} USDC`);
    }
  }
}

// --- Market operations ---

export async function adminSettleMarket(
  program: Program<Meridian>,
  admin: PublicKey | { publicKey: PublicKey },
  market: PublicKey,
  obPda: PublicKey,
  price: number,
  signers?: anchor.web3.Keypair[],
): Promise<"settled" | "already_settled" | "too_early" | "error"> {
  const adminPk = "publicKey" in admin ? admin.publicKey : admin;
  try {
    const builder = program.methods
      .adminSettle(new BN(price))
      .accountsPartial({ admin: adminPk, market })
      .remainingAccounts([{ pubkey: obPda, isSigner: false, isWritable: true }]);
    if (signers) builder.signers(signers);
    await builder.rpc();
    return "settled";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("AlreadySettled") ||
      msg.includes("already settled") ||
      msg.includes("MarketAlreadySettled")
    ) {
      return "already_settled";
    }
    if (msg.includes("AdminSettleTooEarly")) {
      return "too_early";
    }
    console.error(`    adminSettle error: ${msg.slice(0, 120)}`);
    return "error";
  }
}

export async function closeMarketAccount(
  program: Program<Meridian>,
  admin: PublicKey | { publicKey: PublicKey },
  market: PublicKey,
  obPda: PublicKey,
  force: boolean,
  signers?: anchor.web3.Keypair[],
): Promise<boolean> {
  const adminPk = "publicKey" in admin ? admin.publicKey : admin;
  try {
    const builder = program.methods
      .closeMarket(force)
      .accountsPartial({ admin: adminPk, market, orderBook: obPda });
    if (signers) builder.signers(signers);
    await builder.rpc();
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    closeMarket error: ${msg.slice(0, 120)}`);
    return false;
  }
}

export async function settleAllPending(
  program: Program<Meridian>,
  adminPk: PublicKey,
  opts: {
    signers?: anchor.web3.Keypair[];
    priceFn?: (market: any) => number;
    log?: boolean;
  } = {},
): Promise<{ settled: number; errors: number }> {
  const { signers, log = true } = opts;
  // Default price: $1 above strike (always YesWins)
  const priceFn =
    opts.priceFn ?? ((m: any) => m.account.strikePrice.toNumber() + 1_000_000);

  const allMarkets = await (program.account as any).strikeMarket.all();
  const nowSecs = Math.floor(Date.now() / 1000);
  const pending = allMarkets.filter((m: any) => {
    const isPending = "pending" in m.account.outcome;
    const closeTime = m.account.closeTime.toNumber();
    return isPending && closeTime < nowSecs;
  });

  let settled = 0,
    errors = 0;
  for (const m of pending) {
    const ticker = m.account.ticker as string;
    const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
    const syntheticPrice = priceFn(m);

    const [obPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), m.publicKey.toBuffer()],
      program.programId,
    );

    const result = await adminSettleMarket(
      program,
      adminPk,
      m.publicKey,
      obPda,
      syntheticPrice,
      signers,
    );
    if (result === "settled" || result === "already_settled") {
      if (log) console.log(`    Settled: ${ticker} > $${strikeDollars}`);
      settled++;
    } else if (result === "too_early") {
      if (log) console.log(`    Too early: ${ticker} > $${strikeDollars}`);
      errors++;
    } else {
      errors++;
    }
    await sleep(TX_DELAY());
  }
  return { settled, errors };
}

export async function closeAllSettled(
  program: Program<Meridian>,
  adminPk: PublicKey,
  opts: { signers?: anchor.web3.Keypair[]; force?: boolean; log?: boolean } = {},
): Promise<number> {
  const { signers, force = true, log = true } = opts;
  const allMarkets = await (program.account as any).strikeMarket.all();
  const settled = allMarkets.filter((m: any) => "settled" in m.account.status);

  let closed = 0;
  for (const m of settled) {
    const ticker = m.account.ticker as string;
    const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
    const [obPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), m.publicKey.toBuffer()],
      program.programId,
    );

    const ok = await closeMarketAccount(program, adminPk, m.publicKey, obPda, force, signers);
    if (ok) {
      if (log) console.log(`    Closed: ${ticker} > $${strikeDollars}`);
      closed++;
    }
    await sleep(TX_DELAY());
  }
  return closed;
}

export async function createMarketsForTickers(
  program: Program<Meridian>,
  adminPk: PublicKey,
  usdcMint: PublicKey,
  tickers: readonly string[],
  dateSeed: BN,
  closeTime: BN,
): Promise<number> {
  const stockPrices = await fetchStockPrices();
  let totalCreated = 0;

  for (const ticker of tickers) {
    const refPrice = stockPrices.get(ticker);
    const effectivePrice = refPrice || 100;
    const strikes = calculateStrikes(effectivePrice);
    console.log(`  ${ticker} ref=$${effectivePrice.toFixed(2)} -> ${strikes.length} strikes`);

    for (const strikeDollars of strikes) {
      const strikePrice = new BN(strikeDollars * USDC_PER_PAIR);
      try {
        await program.methods
          .createStrikeMarket(ticker, strikePrice, dateSeed, closeTime)
          .accountsPartial({ admin: adminPk, usdcMint })
          .rpc();
        console.log(`    Created: ${ticker} > $${strikeDollars}`);
        totalCreated++;
        await sleep(TX_DELAY());
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already in use")) {
          console.log(`    ${ticker} > $${strikeDollars} already exists`);
          totalCreated++;
        } else {
          console.error(`    Failed: ${ticker} > $${strikeDollars}: ${msg.slice(0, 100)}`);
        }
      }
    }
  }
  return totalCreated;
}
