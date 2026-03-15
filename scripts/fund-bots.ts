/**
 * Fund bot wallets with SOL and USDC. Optional sidecar to devnet-setup.
 * Idempotent - checks balances before funding.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=.wallets/admin.json USDC_MINT=... \
 *     npx tsx scripts/fund-bots.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { getDevWallet } from "./dev-wallets";
import { USDC_PER_PAIR } from "./constants";
import { sleep, defaultTxDelay } from "./bot-utils";

const DEVNET_DELAY_MS = defaultTxDelay();
const BOT_USDC_AMOUNT = 250_000;
const MIN_SOL = 1;
const FUND_SOL = 2;

async function fundFromAdmin(
  connection: anchor.web3.Connection,
  admin: anchor.web3.Keypair,
  recipient: PublicKey,
  lamports: number
): Promise<void> {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const tx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: recipient,
          lamports,
        })
      );
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [admin]);
      return;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      console.log(`  Transfer retry ${i + 1}/${maxRetries}...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function fundBot(
  connection: anchor.web3.Connection,
  admin: anchor.web3.Keypair,
  bot: anchor.web3.Keypair,
  usdcMint: PublicKey,
  label: string,
) {
  const bal = await connection.getBalance(bot.publicKey);
  if (bal < MIN_SOL * LAMPORTS_PER_SOL) {
    console.log(`  ${label}: transferring ${FUND_SOL} SOL from admin...`);
    await fundFromAdmin(connection, admin, bot.publicKey, FUND_SOL * LAMPORTS_PER_SOL);
    await sleep(DEVNET_DELAY_MS);
  }

  const ata = getAssociatedTokenAddressSync(usdcMint, bot.publicKey);
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    admin.publicKey, ata, bot.publicKey, usdcMint
  );
  const tx = new anchor.web3.Transaction().add(createAtaIx);
  await anchor.web3.sendAndConfirmTransaction(connection, tx, [admin]);
  await mintTo(connection, admin, usdcMint, ata, admin, BOT_USDC_AMOUNT * USDC_PER_PAIR);
  console.log(`  ${label}: minted ${BOT_USDC_AMOUNT.toLocaleString()} USDC`);
  await sleep(DEVNET_DELAY_MS);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const admin = getDevWallet("admin");
  const botA = getDevWallet("bot-a");
  const botB = getDevWallet("bot-b");

  const mintAddr = process.env.USDC_MINT;
  if (!mintAddr) {
    console.error("USDC_MINT env var required. Run devnet-setup first.");
    process.exit(1);
  }
  const usdcMint = new PublicKey(mintAddr);

  console.log("=== Fund Bots ===");
  await fundBot(connection, admin, botA, usdcMint, "bot-a");
  await fundBot(connection, admin, botB, usdcMint, "bot-b");
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
