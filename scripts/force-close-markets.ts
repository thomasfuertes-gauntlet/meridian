/**
 * One-off cleanup: force-close all markets using the temporary force_close_market
 * instruction. Tolerates pre-migration undersized OrderBook accounts.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://... ANCHOR_WALLET=.wallets/admin.json npx tsx scripts/force-close-markets.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { PublicKey, Transaction } from "@solana/web3.js";
import { sleep, defaultTxDelay, sendNoConfirm, batchConfirm } from "./bot-utils";

const SEND_DELAY = defaultTxDelay();

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  console.log("=== Force Close All Markets ===");
  console.log(`RPC: ${connection.rpcEndpoint}`);
  console.log(`Admin: ${admin.publicKey.toString()}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  console.log(`Markets found: ${allMarkets.length}`);

  if (allMarkets.length === 0) {
    console.log("Nothing to close.");
    return;
  }

  const balBefore = await connection.getBalance(admin.publicKey);
  const sigs: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < allMarkets.length; i++) {
    const m = allMarkets[i];
    const ticker = m.account.ticker as string;
    const strikeDollars = m.account.strikePrice.toNumber() / 1_000_000;

    const [obPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), m.publicKey.toBuffer()],
      program.programId
    );

    try {
      const ix = await program.methods
        .forceCloseMarket()
        .accountsPartial({
          admin: admin.publicKey,
          market: m.publicKey,
          orderBook: obPda,
        })
        .instruction();

      const tx = new Transaction().add(ix);
      const sig = await sendNoConfirm(connection, tx, [admin]);
      sigs.push(sig);
      process.stdout.write(
        `\r  Sent ${i + 1}/${allMarkets.length}: ${ticker} > $${strikeDollars}    `
      );
    } catch {
      process.stdout.write(
        `\r  Skip ${i + 1}/${allMarkets.length}: ${ticker} > $${strikeDollars} (build failed)    `
      );
    }
    await sleep(SEND_DELAY);
  }

  console.log(`\n  Confirming ${sigs.length} force-close txs...`);
  const result = await batchConfirm(connection, sigs);
  console.log(`  Closed: ${result.confirmed}, Failed: ${result.failed}`);

  const balAfter = await connection.getBalance(admin.publicKey);
  const recovered = (balAfter - balBefore) / 1e9;
  console.log(`\nSOL recovered: ${recovered.toFixed(4)}`);
  console.log("=== Done ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
