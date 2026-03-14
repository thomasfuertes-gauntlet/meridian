/**
 * Deterministic dev wallets for local development.
 * Derived from sha256("meridian-dev-{name}") - same keys every time.
 *
 * Wallets:
 *   admin  - program admin, USDC mint authority, config initializer
 *   bot-a  - seed-bots + live-bots liquidity provider
 *   bot-b  - frontend auto-sign wallet on localhost
 *
 * Set WALLET_MODE=generate to create random keypairs instead of deterministic
 * derivation. Existing files are preserved (never overwritten in generate mode).
 */
import { createHash } from "crypto";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const WALLET_NAMES = ["admin", "bot-a", "bot-b", "trader-1", "trader-2", "trader-3", "trader-4", "trader-5"] as const;
export type WalletName = (typeof WALLET_NAMES)[number];

const WALLETS_DIR = path.join(import.meta.dirname, "../.wallets");
const PROGRAM_KEYPAIR_PATH = process.env.PROGRAM_KEYPAIR_PATH
  || path.join(import.meta.dirname, "../target/deploy/meridian-keypair.json");

const WALLET_MODE = process.env.WALLET_MODE || "deterministic";

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
    const filePath = path.join(WALLETS_DIR, `${name}.json`);
    if (WALLET_MODE === "generate" && fs.existsSync(filePath)) {
      continue; // Don't overwrite existing generated keys
    }
    const kp = WALLET_MODE === "generate" ? Keypair.generate() : deriveKeypair(name);
    // Solana CLI format: JSON array of all 64 secret key bytes
    fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)));
  }
}

/** Ensure program keypair exists in target/deploy/ */
export function ensureProgramKeypair(): Keypair {
  const dir = path.dirname(PROGRAM_KEYPAIR_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (WALLET_MODE === "generate" && fs.existsSync(PROGRAM_KEYPAIR_PATH)) {
    const existing = JSON.parse(fs.readFileSync(PROGRAM_KEYPAIR_PATH, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(existing));
  }
  const kp = WALLET_MODE === "generate" ? Keypair.generate() : deriveKeypair("program");
  fs.writeFileSync(PROGRAM_KEYPAIR_PATH, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

// When run directly, generate wallet files and print pubkeys
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureWalletFiles();
  const programKp = ensureProgramKeypair();
  console.log(`Dev wallets written to .wallets/ (mode: ${WALLET_MODE})`);
  for (const name of WALLET_NAMES) {
    // In generate mode, read back the written file to show actual pubkeys
    if (WALLET_MODE === "generate") {
      const filePath = path.join(WALLETS_DIR, `${name}.json`);
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf-8"))));
      console.log(`  ${name}: ${kp.publicKey.toString()}`);
    } else {
      const kp = deriveKeypair(name);
      console.log(`  ${name}: ${kp.publicKey.toString()}`);
    }
  }
  console.log(`  program: ${programKp.publicKey.toString()}`);
}
