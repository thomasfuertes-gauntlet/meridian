import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";

describe("meridian", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet;

  let configPda: PublicKey;
  let configBump: number;
  let usdcMint: PublicKey;

  before(async () => {
    // Derive config PDA
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Create a fake USDC mint (6 decimals) for testing
    const mintAuthority = Keypair.generate();

    // Airdrop SOL to mint authority
    const sig = await provider.connection.requestAirdrop(
      mintAuthority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    usdcMint = await createMint(
      provider.connection,
      mintAuthority,
      mintAuthority.publicKey,
      null,
      6 // USDC has 6 decimals
    );
  });

  it("initializes global config", async () => {
    await program.methods
      .initializeConfig()
      .accountsPartial({
        admin: admin.publicKey,
      })
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(
      admin.publicKey.toBase58()
    );
    expect(configAccount.paused).to.equal(false);
    expect(configAccount.bump).to.equal(configBump);
  });

  it("creates a strike market", async () => {
    const ticker = "META";
    const strikePrice = new anchor.BN(680_000_000); // $680.00 in USDC base units
    const date = new anchor.BN(Math.floor(Date.now() / 1000)); // today

    // Derive market PDA
    const [marketPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        Buffer.from(ticker),
        strikePrice.toArrayLike(Buffer, "le", 8),
        date.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Derive yes_mint PDA
    const [yesMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_mint"), marketPda.toBuffer()],
      program.programId
    );

    // Derive no_mint PDA
    const [noMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("no_mint"), marketPda.toBuffer()],
      program.programId
    );

    // Derive vault PDA
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createStrikeMarket(ticker, strikePrice, date)
      .accountsPartial({
        admin: admin.publicKey,
        usdcMint: usdcMint,
      })
      .rpc();

    // Fetch and verify market account
    const marketAccount = await program.account.strikeMarket.fetch(marketPda);
    expect(marketAccount.ticker).to.equal(ticker);
    expect(marketAccount.strikePrice.toNumber()).to.equal(680_000_000);
    expect(marketAccount.date.toNumber()).to.equal(date.toNumber());
    expect(marketAccount.outcome).to.deep.equal({ pending: {} });
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(0);
    expect(marketAccount.yesMint.toBase58()).to.equal(yesMintPda.toBase58());
    expect(marketAccount.noMint.toBase58()).to.equal(noMintPda.toBase58());
    expect(marketAccount.vault.toBase58()).to.equal(vaultPda.toBase58());
    expect(marketAccount.admin.toBase58()).to.equal(
      admin.publicKey.toBase58()
    );
    expect(marketAccount.settledAt).to.be.null;

    // Verify yes_mint exists and has correct properties
    const yesMintInfo = await provider.connection.getAccountInfo(yesMintPda);
    expect(yesMintInfo).to.not.be.null;

    // Verify no_mint exists
    const noMintInfo = await provider.connection.getAccountInfo(noMintPda);
    expect(noMintInfo).to.not.be.null;

    // Verify vault exists
    const vaultInfo = await provider.connection.getAccountInfo(vaultPda);
    expect(vaultInfo).to.not.be.null;
  });
});
