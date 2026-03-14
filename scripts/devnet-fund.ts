/**
 * Fund dev wallets with SOL airdrops on devnet.
 * Requests 2 SOL per airdrop (devnet limit), retries with exponential backoff.
 * Checks existing balances first, only airdrops the delta.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npx tsx scripts/devnet-fund.ts
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getDevWallet } from "./dev-wallets";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const AIRDROP_AMOUNT = 2 * LAMPORTS_PER_SOL; // devnet cap per request
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 3000;

interface FundTarget {
  name: string;
  targetSol: number;
}

const TARGETS: FundTarget[] = [
  { name: "admin", targetSol: 8 },   // ~5 SOL for deploy + 3 for tx fees
  { name: "bot-a", targetSol: 2 },
  { name: "bot-b", targetSol: 2 },
];

async function airdropWithRetry(
  connection: Connection,
  pubkey: PublicKey,
  lamports: number,
  label: string
): Promise<boolean> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, lamports);
      await connection.confirmTransaction(sig, "confirmed");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === MAX_RETRIES - 1) {
        console.error(`  [fail] ${label}: ${msg.slice(0, 100)}`);
        return false;
      }
      const delay = BASE_DELAY_MS * Math.pow(2, i);
      console.log(`  [retry ${i + 1}/${MAX_RETRIES}] ${label}: ${msg.slice(0, 60)}... waiting ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return false;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  console.log("=== Devnet SOL Funding ===");
  console.log(`RPC: ${RPC_URL}\n`);

  for (const { name, targetSol } of TARGETS) {
    const wallet = getDevWallet(name as any);
    const pubkey = wallet.publicKey;
    const balance = await connection.getBalance(pubkey);
    const currentSol = balance / LAMPORTS_PER_SOL;
    const neededSol = targetSol - currentSol;

    if (neededSol <= 0.5) {
      console.log(`${name}: ${currentSol.toFixed(2)} SOL (>= ${targetSol} target, skipping)`);
      continue;
    }

    console.log(`${name}: ${currentSol.toFixed(2)} SOL -> need ${neededSol.toFixed(2)} more`);

    // Request 2 SOL at a time until we hit target
    const requests = Math.ceil(neededSol / 2);
    let funded = 0;
    for (let i = 0; i < requests; i++) {
      const ok = await airdropWithRetry(connection, pubkey, AIRDROP_AMOUNT, `${name} airdrop ${i + 1}/${requests}`);
      if (ok) {
        funded++;
        console.log(`  +2 SOL -> ${name}`);
      } else {
        console.error(`  Airdrop failed for ${name}, continuing...`);
        break;
      }
      // Devnet rate-limits airdrops aggressively - wait between requests
      if (i < requests - 1) {
        await new Promise(r => setTimeout(r, BASE_DELAY_MS));
      }
    }
  }

  // Print final balances
  console.log("\nFinal balances:");
  for (const { name } of TARGETS) {
    const wallet = getDevWallet(name as any);
    const balance = await connection.getBalance(wallet.publicKey);
    console.log(`  ${name}: ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL (${wallet.publicKey.toString()})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
