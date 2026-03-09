/**
 * Deterministic dev wallets for local development.
 * Derived from sha256("meridian-dev-{name}") - same keys every time.
 *
 * Wallets:
 *   admin  - program admin, USDC mint authority, config initializer
 *   bot-a  - seed-bots + live-bots liquidity provider
 *   bot-b  - frontend auto-sign wallet on localhost
 */
import { createHash } from "crypto";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const WALLET_NAMES = ["admin", "bot-a", "bot-b"] as const;
export type WalletName = (typeof WALLET_NAMES)[number];

const WALLETS_DIR = path.join(__dirname, "../.wallets");
const PROGRAM_KEYPAIR_PATH = path.join(__dirname, "../target/deploy/meridian-keypair.json");

function deriveKeypair(name: string): Keypair {
  const seed = createHash("sha256").update(`meridian-dev-${name}`).digest();
  return Keypair.fromSeed(seed);
}

/** Get a deterministic dev keypair by name */
export function getDevWallet(name: WalletName): Keypair {
  return deriveKeypair(name);
}

/** Write all dev wallets to .wallets/ as Solana CLI JSON format */
export function ensureWalletFiles(): void {
  if (!fs.existsSync(WALLETS_DIR)) {
    fs.mkdirSync(WALLETS_DIR, { recursive: true });
  }

  for (const name of WALLET_NAMES) {
    const kp = deriveKeypair(name);
    const filePath = path.join(WALLETS_DIR, `${name}.json`);
    // Solana CLI format: JSON array of all 64 secret key bytes
    fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)));
  }
}

/** Ensure deterministic program keypair exists in target/deploy/ */
export function ensureProgramKeypair(): Keypair {
  const kp = deriveKeypair("program");
  const dir = path.dirname(PROGRAM_KEYPAIR_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PROGRAM_KEYPAIR_PATH, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

// When run directly, generate wallet files and print pubkeys
if (require.main === module) {
  ensureWalletFiles();
  const programKp = ensureProgramKeypair();
  console.log("Dev wallets written to .wallets/");
  for (const name of WALLET_NAMES) {
    const kp = deriveKeypair(name);
    console.log(`  ${name}: ${kp.publicKey.toString()}`);
  }
  console.log(`  program: ${programKp.publicKey.toString()}`);
}
