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
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import * as fs from "fs";
import * as path from "path";
import { USDC_DECIMALS } from "./constants";
const WARN_SOL = 0.5;
const CRIT_SOL = 0.1;
const WARN_USDC = 500;
const CRIT_USDC = 50;
const ORDER_BOOK_BATCH_SIZE = Number(process.env.HEALTHCHECK_OB_BATCH_SIZE || 40);
const ORDER_BOOK_BATCH_DELAY_MS = Number(process.env.HEALTHCHECK_OB_BATCH_DELAY_MS || 250);
const ORDER_BOOK_BATCH_RETRIES = Number(process.env.HEALTHCHECK_OB_BATCH_RETRIES || 4);

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function getMultipleAccountsInfoBatched(
  connection: anchor.web3.Connection,
  pubkeys: PublicKey[],
  batchSize = ORDER_BOOK_BATCH_SIZE
) {
  const results = [];
  for (let i = 0; i < pubkeys.length; i += batchSize) {
    const batch = pubkeys.slice(i, i + batchSize);
    let accounts = null;
    for (let attempt = 0; attempt <= ORDER_BOOK_BATCH_RETRIES; attempt++) {
      try {
        accounts = await connection.getMultipleAccountsInfo(batch);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimited = msg.includes("429") || msg.toLowerCase().includes("rate limit");
        if (!isRateLimited || attempt === ORDER_BOOK_BATCH_RETRIES) {
          throw err;
        }
        const delayMs = ORDER_BOOK_BATCH_DELAY_MS * Math.pow(2, attempt);
        await sleep(delayMs);
      }
    }
    if (!accounts) {
      throw new Error("Failed to fetch order book batch");
    }
    results.push(...accounts);
    if (i + batchSize < pubkeys.length) {
      await sleep(ORDER_BOOK_BATCH_DELAY_MS);
    }
  }
  return results;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;

  // Load USDC mint
  let usdcMintStr = process.env.USDC_MINT;
  if (!usdcMintStr) {
    const configPath = path.join(import.meta.dirname, "../frontend/src/lib/local-config.json");
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
  const DRAIN_TARGET = new PublicKey("5Ux797xeoqotK8b6qtjYWwfS2fv7p9ZLV9V2ZAcxiyo");
  const DRAIN_WALLETS = ["trader-1", "trader-2", "trader-3", "trader-4", "trader-5"] as const;
  const RENT_EXEMPT_MIN = 890_880; // lamports to keep account alive

  const wallets = [
    { name: "admin", kp: getDevWallet("admin") },
    { name: "bot-a", kp: getDevWallet("bot-a") },
    { name: "bot-b", kp: getDevWallet("bot-b") },
    ...DRAIN_WALLETS.map((name) => ({ name, kp: getDevWallet(name) })),
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
      `  ${w.name.padEnd(10)} ${ws.pubkey.slice(0, 8)}... ` +
      `SOL: ${sol.toFixed(2).padStart(8)} [${icon(ws.solStatus)}]  ` +
      `USDC: ${usdc.toFixed(0).padStart(8)} [${icon(ws.usdcStatus)}]`
    );
  }

  // Drain trader wallets - recover SOL to personal wallet
  let drainedTotal = 0;
  for (const name of DRAIN_WALLETS) {
    const kp = getDevWallet(name);
    const balance = await connection.getBalance(kp.publicKey);
    if (balance > RENT_EXEMPT_MIN + 5000) { // 5000 lamports for tx fee
      const drainAmount = balance - 5000; // leave just enough for fee, account closes after
      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: DRAIN_TARGET,
            lamports: drainAmount,
          })
        );
        await sendAndConfirmTransaction(connection, tx, [kp]);
        const solDrained = drainAmount / LAMPORTS_PER_SOL;
        drainedTotal += solDrained;
        console.log(`  [DRAIN] ${name}: ${solDrained.toFixed(4)} SOL -> ${DRAIN_TARGET.toString().slice(0, 8)}...`);
      } catch (err) {
        console.log(`  [DRAIN] ${name}: failed - ${err instanceof Error ? err.message.slice(0, 80) : err}`);
      }
    }
  }
  if (drainedTotal > 0) {
    console.log(`  [DRAIN] Total recovered: ${drainedTotal.toFixed(4)} SOL`);
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

    // Check order book fill rates by reading bid_count/ask_count from raw data
    // OrderBook layout: 8 (discriminator) + ... + bid_count(u16) at offset 104, ask_count(u16) at offset 106
    const OB_BID_COUNT_OFFSET = 8 + 104; // 8-byte Anchor discriminator + 104 bytes to bid_count
    const OB_ASK_COUNT_OFFSET = OB_BID_COUNT_OFFSET + 2;
    const missingBooks: string[] = [];
    const emptyBooks: string[] = [];
    const seededBooks: string[] = [];
    let totalBids = 0;
    let totalAsks = 0;

    // Batch fetch all order book accounts
    const obPdas = pending.map((m: { publicKey: PublicKey }) => {
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), m.publicKey.toBuffer()],
        program.programId
      );
      return obPda;
    });
    const obAccounts = await getMultipleAccountsInfoBatched(connection, obPdas);

    for (let i = 0; i < pending.length; i++) {
      const m = pending[i];
      const label = `${m.account.ticker} > $${(m.account.strikePrice.toNumber() / 1_000_000).toFixed(0)}`;
      const obInfo = obAccounts[i];

      if (!obInfo) {
        missingBooks.push(label);
        continue;
      }

      const bidCount = obInfo.data.readUInt16LE(OB_BID_COUNT_OFFSET);
      const askCount = obInfo.data.readUInt16LE(OB_ASK_COUNT_OFFSET);
      totalBids += bidCount;
      totalAsks += askCount;

      if (bidCount === 0 && askCount === 0) {
        emptyBooks.push(label);
      } else {
        seededBooks.push(label);
      }
    }

    if (missingBooks.length > 0) {
      console.log(`  [CRIT] ${missingBooks.length} markets missing order book account: ${missingBooks.slice(0, 3).join(", ")}${missingBooks.length > 3 ? "..." : ""}`);
    }
    if (emptyBooks.length > 0) {
      console.log(`  [WARN] ${emptyBooks.length} markets with ZERO orders (not seeded): ${emptyBooks.slice(0, 5).join(", ")}${emptyBooks.length > 5 ? "..." : ""}`);
      if (emptyBooks.length > pending.length / 2) {
        console.log(`         -> Bots may have crashed mid-seed. Redeploy:`);
        console.log(`            railway up -s bots -d`);
      }
    }
    console.log(`  Seeded: ${seededBooks.length}/${pending.length} markets  Orders: ${totalBids} bids, ${totalAsks} asks`);
    if (seededBooks.length === pending.length && emptyBooks.length === 0 && missingBooks.length === 0) {
      console.log(`  [OK] All markets fully seeded`);
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

  // Market freshness & schedule awareness
  console.log("\n--- Schedule ---");
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayOfWeek = et.getDay(); // 0=Sun, 6=Sat
  const etHour = et.getHours();
  const etMin = et.getMinutes();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isMarketHours = !isWeekend && etHour * 60 + etMin >= 570 && etHour * 60 + etMin <= 960; // 9:30-16:00
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  console.log(`  ET: ${dayNames[dayOfWeek]} ${et.toLocaleTimeString("en-US", { timeZone: "America/New_York" })}`);
  console.log(`  Market hours: ${isMarketHours ? "OPEN" : isWeekend ? "WEEKEND" : "CLOSED"}`);
  console.log(`  Bot price mode: ${process.env.OFFLINE === "1" ? "OFFLINE (synthetic)" : isMarketHours ? "Pyth Hermes (live)" : "auto-fallback (synthetic)"}`);

  // Check if markets are stale (close_time in the past = need fresh markets)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allMarketsForSchedule = await (program.account as any).strikeMarket.all();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeMarkets = allMarketsForSchedule.filter((m: any) => m.account.outcome?.pending !== undefined);
    const nowUnix = Date.now() / 1000;

    if (activeMarkets.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeTimes = activeMarkets.map((m: any) => m.account.closeTime.toNumber());
      const earliest = Math.min(...closeTimes);
      const allExpired = earliest < nowUnix;
      const hoursStale = allExpired ? (nowUnix - earliest) / 3600 : 0;

      // Compute the close date in ET for display
      const closeDate = new Date(earliest * 1000);
      const closeDateET = closeDate.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });

      if (allExpired && hoursStale > 24) {
        console.log(`  [WARN] Markets are stale! Close time was ${closeDateET} (${hoursStale.toFixed(0)}h ago)`);
        console.log(`         These markets were created for a previous trading day.`);
        if (!isWeekend) {
          console.log(`         -> Run: make setup-devnet  (creates fresh markets for today)`);
          console.log(`         -> Then redeploy bots: railway up -s bots`);
        } else {
          console.log(`         -> No action needed until Monday. Bots use synthetic prices on weekends.`);
          console.log(`         -> Monday morning: make setup-devnet`);
          console.log(`         -> Then: railway up -s bots -d`);
        }
      } else if (allExpired) {
        console.log(`  [INFO] Markets past close time (${closeDateET}). Settlement window open.`);
        if (isWeekend) {
          console.log(`         -> Pyth has no weekend equity data. settle_market won't work.`);
          console.log(`         -> Use admin_settle for manual resolution, or wait for Monday.`);
        } else {
          console.log(`         -> settle_market can be cranked if Pyth has a fresh price.`);
          console.log(`         -> Or create tomorrow's markets: make setup-devnet`);
        }
      } else {
        const hoursUntilClose = (earliest - nowUnix) / 3600;
        console.log(`  [OK] Markets are fresh (close: ${closeDateET}, ${hoursUntilClose.toFixed(1)}h from now)`);
      }

      // Check if it's a weekday morning and markets are from a previous day
      if (!isWeekend && etHour < 10) {
        const closeDayET = new Date(earliest * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York" });
        const todayET = et.toLocaleDateString("en-US");
        if (closeDayET !== todayET) {
          console.log(`\n  ** WEEKDAY MORNING CHECKLIST **`);
          console.log(`  1. make setup-devnet                              # create today's markets`);
          console.log(`  2. railway up -s bots -d                          # redeploy + seed + live`);
          console.log(`  3. make health                                    # verify everything is fresh`);
        }
      }
    }
  } catch {
    // Market fetch already reported above, skip duplicate error
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
