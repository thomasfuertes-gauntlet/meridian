/**
 * Devnet infrastructure setup: USDC mint + GlobalConfig.
 * Idempotent - safe to run multiple times.
 *
 * Bot funding is separate: `make devnet-fund-bots` or `npx tsx scripts/fund-bots.ts`.
 * Market creation is handled by automation cron (morning-job.ts).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=.wallets/admin.json \
 *     USDC_MINT=... npx tsx scripts/setup-devnet.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import { USDC_DECIMALS, USDC_PER_PAIR } from "./constants";
import { accountExists } from "./market-ops";
import { defaultTxDelay, sleep } from "./bot-utils";

const DEVNET_DELAY_MS = defaultTxDelay();

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet;
  const connection = provider.connection;
  const adminKeypair = getDevWallet("admin");

  console.log("=== Meridian Devnet Setup ===");
  console.log("Program ID:", program.programId.toString());
  console.log("Admin:", admin.publicKey.toString());

  // USDC mint: use existing or create new
  let usdcMint: PublicKey;
  const existingMint = process.env.USDC_MINT;
  if (existingMint) {
    usdcMint = new PublicKey(existingMint);
    console.log("\nUsing existing USDC mint:", usdcMint.toString());
  } else {
    usdcMint = await createMint(
      connection,
      adminKeypair,
      adminKeypair.publicKey,
      null,
      USDC_DECIMALS
    );
    console.log("\nCreated USDC Mint:", usdcMint.toString());
  }

  // Admin USDC ATA - create if missing, seed only if empty
  const adminAtaAddr = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
  if (!(await accountExists(connection, adminAtaAddr))) {
    await createAssociatedTokenAccount(connection, adminKeypair, usdcMint, admin.publicKey);
    console.log("Created admin USDC ATA");
  }
  const adminBalance = await connection.getTokenAccountBalance(adminAtaAddr);
  if (Number(adminBalance.value.amount) === 0) {
    await mintTo(connection, adminKeypair, usdcMint, adminAtaAddr, adminKeypair, 1000 * USDC_PER_PAIR);
    console.log("Minted 1000 USDC to admin");
    await sleep(DEVNET_DELAY_MS);
  } else {
    console.log(`Admin USDC: ${adminBalance.value.uiAmountString} (skipping mint)`);
  }

  // Initialize GlobalConfig
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  if (await accountExists(connection, configPda)) {
    console.log("Config already initialized, skipping");
  } else {
    await program.methods
      .initializeConfig()
      .accountsPartial({ admin: admin.publicKey })
      .rpc();
    console.log("Config initialized");
  }

  // Write local-config.json for frontend
  const fs = await import("fs");
  const configPath = `${import.meta.dirname}/../frontend/src/lib/local-config.json`;
  fs.writeFileSync(
    configPath,
    JSON.stringify({ usdcMint: usdcMint.toString() }, null, 2)
  );

  console.log("\n=== Devnet Setup Complete ===");
  console.log(`USDC Mint: ${usdcMint.toString()}`);
  console.log(`\nEnsure .env has: DEVNET_USDC_MINT=${usdcMint.toString()}`);
  console.log(`To fund bots: make devnet-fund-bots`);
  console.log(`To create markets: npx tsx scripts/automation.ts --now`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
