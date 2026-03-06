/**
 * Local development setup script.
 * Run after `anchor deploy` on local validator.
 *
 * Creates: config, USDC mint, 7 test markets (one per MAG7 stock),
 * order books, and airdrops USDC to a specified wallet.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

const MAG7_STRIKES: { ticker: string; strike: number }[] = [
  { ticker: "AAPL", strike: 230_000_000 },
  { ticker: "MSFT", strike: 420_000_000 },
  { ticker: "GOOGL", strike: 180_000_000 },
  { ticker: "AMZN", strike: 200_000_000 },
  { ticker: "NVDA", strike: 130_000_000 },
  { ticker: "META", strike: 680_000_000 },
  { ticker: "TSLA", strike: 250_000_000 },
];

const USDC_DECIMALS = 6;
const USDC_PER_PAIR = 1_000_000;
// Dummy Pyth feed ID (32 zero bytes) - local validator has no Pyth
const dummyPythFeedId = Array(32).fill(0);
// close_time = 0 so admin_settle works (0 + 3600 < any real clock)
const pastCloseTime = new anchor.BN(0);
const today = new anchor.BN(Math.floor(Date.now() / 86400000));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet;
  const connection = provider.connection;

  console.log("Program ID:", program.programId.toString());
  console.log("Admin:", admin.publicKey.toString());

  // Optional: airdrop USDC to a browser wallet (pass as CLI arg)
  const browserWallet = process.argv[2] ? new PublicKey(process.argv[2]) : null;
  if (browserWallet) {
    console.log("Browser wallet:", browserWallet.toString());
    // Airdrop SOL to browser wallet for tx fees
    const sig = await connection.requestAirdrop(browserWallet, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    console.log("Airdropped 5 SOL to browser wallet");
  }

  // 1. Create USDC mint (admin is mint authority)
  const mintAuthority = Keypair.generate();
  const mintAuthAirdrop = await connection.requestAirdrop(
    mintAuthority.publicKey,
    2 * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(mintAuthAirdrop);

  const usdcMint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey,
    null,
    USDC_DECIMALS
  );
  console.log("USDC Mint:", usdcMint.toString());

  // 2. Create admin USDC ATA and mint USDC
  const adminUsdcAta = await createAssociatedTokenAccount(
    connection,
    mintAuthority,
    usdcMint,
    admin.publicKey
  );
  await mintTo(
    connection,
    mintAuthority,
    usdcMint,
    adminUsdcAta,
    mintAuthority,
    1000 * USDC_PER_PAIR // 1000 USDC
  );
  console.log("Minted 1000 USDC to admin");

  // 3. If browser wallet, create its USDC ATA and mint
  if (browserWallet) {
    const browserUsdcAta = getAssociatedTokenAddressSync(usdcMint, browserWallet);
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      mintAuthority.publicKey,
      browserUsdcAta,
      browserWallet,
      usdcMint
    );
    const tx = new anchor.web3.Transaction().add(createAtaIx);
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [mintAuthority]);
    await mintTo(
      connection,
      mintAuthority,
      usdcMint,
      browserUsdcAta,
      mintAuthority,
      100 * USDC_PER_PAIR // 100 USDC
    );
    console.log("Minted 100 USDC to browser wallet");
  }

  // 4. Initialize config
  await program.methods
    .initializeConfig()
    .accountsPartial({ admin: admin.publicKey })
    .rpc();
  console.log("Config initialized");

  // 5. Create markets + order books for each MAG7 stock
  for (const { ticker, strike } of MAG7_STRIKES) {
    const strikePrice = new anchor.BN(strike);
    const [marketPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        Buffer.from(ticker),
        strikePrice.toArrayLike(Buffer, "le", 8),
        today.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Create market
    await program.methods
      .createStrikeMarket(ticker, strikePrice, today, pastCloseTime, dummyPythFeedId)
      .accountsPartial({ admin: admin.publicKey, usdcMint })
      .rpc();
    console.log(`Created market: ${ticker} > $${strike / USDC_PER_PAIR}`);

    // Initialize order book
    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), marketPda.toBuffer()],
      program.programId
    );
    const [obUsdcVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("ob_usdc_vault"), marketPda.toBuffer()],
      program.programId
    );
    const [obYesVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("ob_yes_vault"), marketPda.toBuffer()],
      program.programId
    );
    const [yesMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_mint"), marketPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeOrderBook()
      .accountsPartial({
        admin: admin.publicKey,
        market: marketPda,
        yesMint: yesMintPda,
        usdcMint,
      })
      .rpc();
    console.log(`  Order book initialized for ${ticker}`);
  }

  // Print summary
  console.log("\n--- Setup Complete ---");
  console.log(`USDC Mint: ${usdcMint.toString()}`);
  console.log(`Markets created: ${MAG7_STRIKES.length}`);
  console.log(`\nUpdate DEVNET_USDC_MINT in app/src/pages/Trade.tsx and Portfolio.tsx with:`);
  console.log(`  ${usdcMint.toString()}`);
  if (browserWallet) {
    console.log(`\nBrowser wallet ${browserWallet.toString()} funded with:`);
    console.log(`  5 SOL (tx fees) + 100 USDC (trading)`);
  }
  console.log(`\nFrontend: update app/src/lib/constants.ts DEVNET_RPC to "http://localhost:8899"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
