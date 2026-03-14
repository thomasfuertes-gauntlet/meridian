/**
 * Patches program ID in lib.rs and Anchor.toml from the program keypair file.
 * Used by bootstrap-fresh to update the codebase for a new program keypair.
 *
 * Usage:
 *   npx tsx scripts/patch-program-id.ts
 *   PROGRAM_KEYPAIR_PATH=target/deploy/meridian-keypair.json npx tsx scripts/patch-program-id.ts
 */
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(import.meta.dirname, "..");
const PROGRAM_KEYPAIR_PATH = process.env.PROGRAM_KEYPAIR_PATH
  || path.join(ROOT, "target/deploy/meridian-keypair.json");

const keypairBytes = JSON.parse(fs.readFileSync(PROGRAM_KEYPAIR_PATH, "utf-8"));
const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairBytes));
const programId = keypair.publicKey.toString();

// Patch lib.rs
const libRsPath = path.join(ROOT, "programs/meridian/src/lib.rs");
let libRs = fs.readFileSync(libRsPath, "utf-8");
libRs = libRs.replace(/declare_id!\(".*?"\)/, `declare_id!("${programId}")`);
fs.writeFileSync(libRsPath, libRs);

// Patch Anchor.toml
const anchorTomlPath = path.join(ROOT, "Anchor.toml");
let anchorToml = fs.readFileSync(anchorTomlPath, "utf-8");
// Replace all meridian = "..." lines under [programs.*]
anchorToml = anchorToml.replace(
  /^(meridian\s*=\s*)".*?"$/gm,
  `$1"${programId}"`
);
fs.writeFileSync(anchorTomlPath, anchorToml);

console.log(`Patched program ID: ${programId}`);
console.log(`  lib.rs: ${libRsPath}`);
console.log(`  Anchor.toml: ${anchorTomlPath}`);
