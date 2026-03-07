/**
 * Devnet health check - run daily or before demos.
 * Reports wallet balances, market status, and actionable warnings.
 *
 * Usage:
 *   make health                    # uses .env or defaults to devnet
 *   ANCHOR_PROVIDER_URL=... npx tsx scripts/health-check.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import * as fs from "fs";
import * as path from "path";

const USDC_DECIMALS = 6;
const WARN_SOL = 0.5;
const CRIT_SOL = 0.1;
const WARN_USDC = 500;
const CRIT_USDC = 50;

interface WalletStatus {
  name: string;
  pubkey: string;
  sol: number;
  usdc: number;
  solStatus: "ok" | "warn" | "crit";
  usdcStatus: "ok" | "warn" | "crit";
}

function status(val: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (val < crit) return "crit";
  if (val < warn) return "warn";
  return "ok";
}

function icon(s: "ok" | "warn" | "crit"): string {
  return s === "ok" ? "OK" : s === "warn" ? "WARN" : "CRIT";
}

async function getUsdcBalance(
  connection: anchor.web3.Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 10 ** USDC_DECIMALS;
  } catch {
    return 0;
  }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;

  // Load USDC mint
  let usdcMintStr = process.env.USDC_MINT;
  if (!usdcMintStr) {
    const configPath = path.join(__dirname, "../app/src/lib/local-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      usdcMintStr = config.usdcMint;
    }
  }

  const rpc = connection.rpcEndpoint;
  const isLocalhost = rpc.includes("localhost") || rpc.includes("127.0.0.1");

  console.log("=== Meridian Health Check ===");
  console.log(`RPC: ${rpc}`);
  console.log(`Environment: ${isLocalhost ? "localhost" : "devnet"}`);
  console.log(`Program: ${program.programId.toString()}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // Check program exists
  try {
    const programInfo = await connection.getAccountInfo(program.programId);
    if (!programInfo) {
      console.log("[CRIT] Program not deployed!\n");
    } else {
      console.log(`[OK] Program deployed (${(programInfo.data.length / 1024).toFixed(0)} KB)\n`);
    }
  } catch (err) {
    console.log(`[CRIT] Cannot reach RPC: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  // Wallet balances
  const wallets = [
    { name: "admin", kp: getDevWallet("admin") },
    { name: "bot-a", kp: getDevWallet("bot-a") },
    { name: "bot-b", kp: getDevWallet("bot-b") },
  ];

  const usdcMint = usdcMintStr ? new PublicKey(usdcMintStr) : null;
  const statuses: WalletStatus[] = [];

  console.log("--- Wallet Balances ---");
  for (const w of wallets) {
    const sol = (await connection.getBalance(w.kp.publicKey)) / LAMPORTS_PER_SOL;
    const usdc = usdcMint ? await getUsdcBalance(connection, usdcMint, w.kp.publicKey) : 0;
    const solThreshWarn = w.name === "admin" ? 2.0 : WARN_SOL;
    const solThreshCrit = w.name === "admin" ? 0.5 : CRIT_SOL;
    const ws: WalletStatus = {
      name: w.name,
      pubkey: w.kp.publicKey.toString(),
      sol,
      usdc,
      solStatus: status(sol, solThreshWarn, solThreshCrit),
      usdcStatus: w.name === "admin" ? "ok" : status(usdc, WARN_USDC, CRIT_USDC),
    };
    statuses.push(ws);
    console.log(
      `  ${w.name.padEnd(7)} ${ws.pubkey.slice(0, 8)}... ` +
      `SOL: ${sol.toFixed(2).padStart(8)} [${icon(ws.solStatus)}]  ` +
      `USDC: ${usdc.toFixed(0).padStart(8)} [${icon(ws.usdcStatus)}]`
    );
  }

  // Market status
  console.log("\n--- Markets ---");
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allMarkets = await (program.account as any).strikeMarket.all();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = allMarkets.filter((m: any) => m.account.outcome?.pending !== undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settled = allMarkets.filter((m: any) => m.account.outcome?.pending === undefined);

    console.log(`  Total: ${allMarkets.length}  Active: ${pending.length}  Settled: ${settled.length}`);

    // Check order book fill rates
    const emptyBooks: string[] = [];
    for (const m of pending) {
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), m.publicKey.toBuffer()],
        program.programId
      );
      const obInfo = await connection.getAccountInfo(obPda);
      if (!obInfo) {
        emptyBooks.push(`${m.account.ticker} > $${(m.account.strikePrice.toNumber() / 1_000_000).toFixed(0)}`);
        continue;
      }
      // Check if order book has any active orders (quick heuristic: data beyond header)
      // Full parse would require zero_copy deserialization, just check byte activity
    }

    if (emptyBooks.length > 0) {
      console.log(`  [WARN] ${emptyBooks.length} markets missing order books: ${emptyBooks.slice(0, 5).join(", ")}${emptyBooks.length > 5 ? "..." : ""}`);
    } else {
      console.log(`  [OK] All active markets have order books`);
    }

    // Check close times
    if (pending.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeTimes = pending.map((m: any) => m.account.closeTime.toNumber());
      const earliest = Math.min(...closeTimes);
      const hoursUntil = (earliest - Date.now() / 1000) / 3600;
      if (hoursUntil < 0) {
        console.log(`  [WARN] ${pending.length} markets past close time (need settlement)`);
      } else {
        console.log(`  [OK] Next settlement in ${hoursUntil.toFixed(1)} hours`);
      }
    }
  } catch (err) {
    console.log(`  [CRIT] Cannot fetch markets: ${err instanceof Error ? err.message : err}`);
  }

  // Actionable summary
  console.log("\n--- Actions Needed ---");
  const actions: string[] = [];

  for (const ws of statuses) {
    if (ws.solStatus === "crit") {
      actions.push(`[CRIT] ${ws.name} needs SOL! (${ws.sol.toFixed(2)} SOL remaining)`);
      if (!isLocalhost) {
        actions.push(`       -> solana airdrop 2 ${ws.pubkey} --url devnet`);
        actions.push(`       -> or fund from faucet: https://faucet.solana.com`);
      }
    } else if (ws.solStatus === "warn") {
      actions.push(`[WARN] ${ws.name} SOL getting low (${ws.sol.toFixed(2)} SOL) - top up soon`);
    }
    if (ws.usdcStatus === "crit") {
      actions.push(`[CRIT] ${ws.name} needs USDC! (${ws.usdc.toFixed(0)} USDC remaining)`);
      actions.push(`       -> Admin can mint more (admin is mint authority)`);
    } else if (ws.usdcStatus === "warn") {
      actions.push(`[WARN] ${ws.name} USDC getting low (${ws.usdc.toFixed(0)} USDC) - bots will slow down`);
    }
  }

  if (actions.length === 0) {
    console.log("  All clear - no action needed.");
  } else {
    for (const a of actions) console.log(`  ${a}`);
  }

  console.log("\n=== Health Check Complete ===");

  // Exit with error code if any critical issues
  const hasCrit = statuses.some((s) => s.solStatus === "crit" || s.usdcStatus === "crit");
  if (hasCrit) process.exit(1);
}

main().catch((err) => {
  console.error("Health check failed:", err.message || err);
  process.exit(1);
});
