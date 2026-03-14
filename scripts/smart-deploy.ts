/**
 * Smart deploy: compare local program binary hash with on-chain program and
 * redeploy only if changed. For use with ALPHA_REDEPLOY=1.
 *
 * When deploying:
 * 1. Settle all unsettled markets (admin_settle with force)
 * 2. Close all settled markets (close_market with force)
 * 3. Deploy the new program binary
 * 4. Re-initialize GlobalConfig
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=.wallets/admin.json npx tsx scripts/smart-deploy.ts
 */
import { createHash } from "crypto";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import { USDC_PER_PAIR, sleep, defaultTxDelay } from "./bot-utils";

const ROOT = path.join(import.meta.dirname, "..");
const PROGRAM_SO_PATH = path.join(ROOT, "target/deploy/meridian.so");
const TX_DELAY = defaultTxDelay();

function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function getOnChainProgramHash(
  connection: anchor.web3.Connection,
  programId: PublicKey
): Promise<string | null> {
  try {
    const accountInfo = await connection.getAccountInfo(programId);
    if (!accountInfo || !accountInfo.data) return null;

    // For BPF programs, the program account points to the executable data account
    // Use solana CLI to get the actual program data
    const rpcUrl = connection.rpcEndpoint;
    const output = execSync(
      `solana program show ${programId.toString()} --url "${rpcUrl}" --output json-compact 2>/dev/null`,
      { encoding: "utf-8", timeout: 30_000 }
    );
    const parsed = JSON.parse(output);
    if (parsed.programData) {
      // Fetch the program data account
      const dataAccount = await connection.getAccountInfo(new PublicKey(parsed.programData));
      if (dataAccount && dataAccount.data) {
        // Program data starts after a 45-byte header (authority + slot + option)
        const programBytes = dataAccount.data.subarray(45);
        return createHash("sha256").update(programBytes).digest("hex");
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function forceSettleAll(program: Program<Meridian>, admin: anchor.web3.Keypair): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending = allMarkets.filter((m: any) => "pending" in m.account.outcome);
  let settled = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of pending) {
    const ticker = m.account.ticker as string;
    const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;
    const syntheticPrice = m.account.strikePrice.toNumber() + 1_000_000;

    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), m.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .adminSettle(new BN(syntheticPrice))
        .accountsPartial({
          admin: admin.publicKey,
          market: m.publicKey,
        })
        .remainingAccounts([
          { pubkey: orderBookPda, isSigner: false, isWritable: true },
        ])
        .signers([admin])
        .rpc();
      console.log(`  Settled: ${ticker} > $${strikeDollars}`);
      settled++;
      await sleep(TX_DELAY);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || String(err);
      if (msg.includes("AlreadySettled") || msg.includes("already settled")) {
        settled++;
      } else {
        console.error(`  Failed: ${ticker} > $${strikeDollars}: ${msg.slice(0, 100)}`);
      }
    }
  }
  return settled;
}

async function forceCloseAll(program: Program<Meridian>, admin: anchor.web3.Keypair): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settledMarkets = allMarkets.filter((m: any) => "settled" in m.account.status);
  let closed = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of settledMarkets) {
    const ticker = m.account.ticker as string;
    const strikeDollars = m.account.strikePrice.toNumber() / USDC_PER_PAIR;

    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), m.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .closeMarket(true) // force=true skips unclaimed-fills guard
        .accountsPartial({
          admin: admin.publicKey,
          market: m.publicKey,
          orderBook: orderBookPda,
        })
        .signers([admin])
        .rpc();
      console.log(`  Closed: ${ticker} > $${strikeDollars}`);
      closed++;
      await sleep(TX_DELAY);
    } catch (err: unknown) {
      console.error(
        `  Failed: ${ticker} > $${strikeDollars}: ${((err as { message?: string })?.message || String(err)).slice(0, 100)}`
      );
    }
  }
  return closed;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  console.log("=== Smart Deploy ===");
  console.log(`Program: ${program.programId.toString()}`);

  // Step 1: Build
  console.log("\n[1/4] Building program...");
  execSync("anchor build", { cwd: ROOT, stdio: "inherit" });

  // Step 2: Hash comparison
  console.log("\n[2/4] Comparing hashes...");
  const localHash = hashFile(PROGRAM_SO_PATH);
  console.log(`  Local:    ${localHash}`);

  const onChainHash = await getOnChainProgramHash(connection, program.programId);
  console.log(`  On-chain: ${onChainHash || "(not deployed)"}`);

  if (localHash === onChainHash) {
    console.log("\n  Hashes match - no deploy needed.");
    return;
  }

  console.log("\n  Hashes differ - deploy needed.");

  // Step 3: Force settle + close all existing markets
  console.log("\n[3/4] Cleaning up existing markets...");
  const settled = await forceSettleAll(program, admin);
  console.log(`  Settled ${settled} markets.`);
  const closed = await forceCloseAll(program, admin);
  console.log(`  Closed ${closed} markets.`);

  // Step 4: Deploy
  console.log("\n[4/4] Deploying...");
  const walletPath = process.env.ANCHOR_WALLET || ".wallets/admin.json";
  const cluster =
    connection.rpcEndpoint.includes("localhost") || connection.rpcEndpoint.includes("127.0.0.1")
      ? "localnet"
      : "devnet";
  execSync(
    `anchor deploy --provider.cluster ${cluster} --provider.wallet "${walletPath}" --no-idl`,
    { cwd: ROOT, stdio: "inherit" }
  );

  // Re-init config if it was destroyed
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const configInfo = await connection.getAccountInfo(configPda);
  if (!configInfo) {
    console.log("\n  Re-initializing GlobalConfig...");
    await program.methods
      .initializeConfig()
      .accountsPartial({ admin: admin.publicKey })
      .rpc();
    console.log("  Config initialized.");
  }

  console.log("\n=== Smart Deploy Complete ===");
  console.log(`Deployed new program binary (hash: ${localHash.slice(0, 16)}...)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
