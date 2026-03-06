import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

describe("meridian", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet;

  let configPda: PublicKey;
  let configBump: number;
  let usdcMint: PublicKey;
  let mintAuthority: Keypair;
  let adminUsdcAta: PublicKey;

  // Helper: derive market PDA and related accounts
  function deriveMarketPdas(
    ticker: string,
    strikePrice: anchor.BN,
    date: anchor.BN
  ) {
    const [marketPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        Buffer.from(ticker),
        strikePrice.toArrayLike(Buffer, "le", 8),
        date.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [yesMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_mint"), marketPda.toBuffer()],
      program.programId
    );
    const [noMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("no_mint"), marketPda.toBuffer()],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId
    );
    return { marketPda, yesMintPda, noMintPda, vaultPda };
  }

  // Helper: create a strike market
  async function createMarket(
    ticker: string,
    strikePrice: anchor.BN,
    date: anchor.BN
  ) {
    const pdas = deriveMarketPdas(ticker, strikePrice, date);
    await program.methods
      .createStrikeMarket(ticker, strikePrice, date)
      .accountsPartial({
        admin: admin.publicKey,
        usdcMint: usdcMint,
      })
      .rpc();
    return pdas;
  }

  // Helper: mint USDC to an address
  async function mintUsdc(dest: PublicKey, amount: number) {
    await mintTo(
      provider.connection,
      mintAuthority,
      usdcMint,
      dest,
      mintAuthority,
      amount
    );
  }

  before(async () => {
    // Derive config PDA
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Create a fake USDC mint (6 decimals) for testing
    mintAuthority = Keypair.generate();

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

    // Create admin's USDC ATA and fund it
    adminUsdcAta = await createAssociatedTokenAccount(
      provider.connection,
      mintAuthority,
      usdcMint,
      admin.publicKey
    );
    await mintUsdc(adminUsdcAta, 100_000_000); // 100 USDC
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

  // Shared market for mint/burn tests
  const sharedTicker = "META";
  const sharedStrikePrice = new anchor.BN(680_000_000);
  const sharedDate = new anchor.BN(1700000000);
  let sharedMarket: ReturnType<typeof deriveMarketPdas>;

  it("creates a strike market", async () => {
    sharedMarket = await createMarket(
      sharedTicker,
      sharedStrikePrice,
      sharedDate
    );

    const marketAccount = await program.account.strikeMarket.fetch(
      sharedMarket.marketPda
    );
    expect(marketAccount.ticker).to.equal(sharedTicker);
    expect(marketAccount.strikePrice.toNumber()).to.equal(680_000_000);
    expect(marketAccount.outcome).to.deep.equal({ pending: {} });
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(0);
  });

  it("mints a pair", async () => {
    const userYes = getAssociatedTokenAddressSync(
      sharedMarket.yesMintPda,
      admin.publicKey
    );
    const userNo = getAssociatedTokenAddressSync(
      sharedMarket.noMintPda,
      admin.publicKey
    );

    await program.methods
      .mintPair()
      .accountsPartial({
        user: admin.publicKey,
        market: sharedMarket.marketPda,
        userUsdc: adminUsdcAta,
        vault: sharedMarket.vaultPda,
        yesMint: sharedMarket.yesMintPda,
        noMint: sharedMarket.noMintPda,
        userYes: userYes,
        userNo: userNo,
      })
      .rpc();

    // Verify vault has 1 USDC
    const vaultAccount = await getAccount(
      provider.connection,
      sharedMarket.vaultPda
    );
    expect(Number(vaultAccount.amount)).to.equal(1_000_000);

    // Verify user has 1 Yes and 1 No
    const yesAccount = await getAccount(provider.connection, userYes);
    expect(Number(yesAccount.amount)).to.equal(1);
    const noAccount = await getAccount(provider.connection, userNo);
    expect(Number(noAccount.amount)).to.equal(1);

    const marketAccount = await program.account.strikeMarket.fetch(
      sharedMarket.marketPda
    );
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(1);
  });

  it("mints 4 more pairs (total 5)", async () => {
    const userYes = getAssociatedTokenAddressSync(
      sharedMarket.yesMintPda,
      admin.publicKey
    );
    const userNo = getAssociatedTokenAddressSync(
      sharedMarket.noMintPda,
      admin.publicKey
    );

    for (let i = 0; i < 4; i++) {
      await program.methods
        .mintPair()
        .accountsPartial({
          user: admin.publicKey,
          market: sharedMarket.marketPda,
          userUsdc: adminUsdcAta,
          vault: sharedMarket.vaultPda,
          yesMint: sharedMarket.yesMintPda,
          noMint: sharedMarket.noMintPda,
          userYes: userYes,
          userNo: userNo,
        })
        .rpc();
    }

    const vaultAccount = await getAccount(
      provider.connection,
      sharedMarket.vaultPda
    );
    expect(Number(vaultAccount.amount)).to.equal(5_000_000);

    const yesAccount = await getAccount(provider.connection, userYes);
    expect(Number(yesAccount.amount)).to.equal(5);
    const noAccount = await getAccount(provider.connection, userNo);
    expect(Number(noAccount.amount)).to.equal(5);
  });

  it("burns 2 pairs", async () => {
    const userYes = getAssociatedTokenAddressSync(
      sharedMarket.yesMintPda,
      admin.publicKey
    );
    const userNo = getAssociatedTokenAddressSync(
      sharedMarket.noMintPda,
      admin.publicKey
    );

    await program.methods
      .burnPair(new anchor.BN(2))
      .accountsPartial({
        user: admin.publicKey,
        market: sharedMarket.marketPda,
        userUsdc: adminUsdcAta,
        vault: sharedMarket.vaultPda,
        yesMint: sharedMarket.yesMintPda,
        noMint: sharedMarket.noMintPda,
        userYes: userYes,
        userNo: userNo,
      })
      .rpc();

    const vaultAccount = await getAccount(
      provider.connection,
      sharedMarket.vaultPda
    );
    expect(Number(vaultAccount.amount)).to.equal(3_000_000);

    const yesAccount = await getAccount(provider.connection, userYes);
    expect(Number(yesAccount.amount)).to.equal(3);
    const noAccount = await getAccount(provider.connection, userNo);
    expect(Number(noAccount.amount)).to.equal(3);

    const marketAccount = await program.account.strikeMarket.fetch(
      sharedMarket.marketPda
    );
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(3);
  });

  it("rejects mint on settled market", async () => {
    // Settle the shared market first
    await program.methods
      .settleMarket({ yesWins: {} })
      .accountsPartial({
        admin: admin.publicKey,
        market: sharedMarket.marketPda,
      })
      .rpc();

    const userYes = getAssociatedTokenAddressSync(
      sharedMarket.yesMintPda,
      admin.publicKey
    );
    const userNo = getAssociatedTokenAddressSync(
      sharedMarket.noMintPda,
      admin.publicKey
    );

    try {
      await program.methods
        .mintPair()
        .accountsPartial({
          user: admin.publicKey,
          market: sharedMarket.marketPda,
          userUsdc: adminUsdcAta,
          vault: sharedMarket.vaultPda,
          yesMint: sharedMarket.yesMintPda,
          noMint: sharedMarket.noMintPda,
          userYes: userYes,
          userNo: userNo,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketAlreadySettled");
    }
  });

  it("rejects redeem on unsettled market", async () => {
    // Create a new unsettled market
    const ticker = "AAPL";
    const strikePrice = new anchor.BN(200_000_000);
    const date = new anchor.BN(1700000001);
    const pdas = await createMarket(ticker, strikePrice, date);

    // Mint a pair so we have tokens to try redeeming
    const userYes = getAssociatedTokenAddressSync(
      pdas.yesMintPda,
      admin.publicKey
    );
    const userNo = getAssociatedTokenAddressSync(
      pdas.noMintPda,
      admin.publicKey
    );

    await program.methods
      .mintPair()
      .accountsPartial({
        user: admin.publicKey,
        market: pdas.marketPda,
        userUsdc: adminUsdcAta,
        vault: pdas.vaultPda,
        yesMint: pdas.yesMintPda,
        noMint: pdas.noMintPda,
        userYes: userYes,
        userNo: userNo,
      })
      .rpc();

    try {
      await program.methods
        .redeem(new anchor.BN(1))
        .accountsPartial({
          user: admin.publicKey,
          market: pdas.marketPda,
          userUsdc: adminUsdcAta,
          vault: pdas.vaultPda,
          tokenMint: pdas.yesMintPda,
          userToken: userYes,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketNotSettled");
    }
  });

  it("full lifecycle - Yes wins", async () => {
    const ticker = "MSFT";
    const strikePrice = new anchor.BN(400_000_000);
    const date = new anchor.BN(1700000002);
    const pdas = await createMarket(ticker, strikePrice, date);

    const userYes = getAssociatedTokenAddressSync(
      pdas.yesMintPda,
      admin.publicKey
    );
    const userNo = getAssociatedTokenAddressSync(
      pdas.noMintPda,
      admin.publicKey
    );

    // Record USDC balance before
    const usdcBefore = Number(
      (await getAccount(provider.connection, adminUsdcAta)).amount
    );

    // Mint 10 pairs
    for (let i = 0; i < 10; i++) {
      await program.methods
        .mintPair()
        .accountsPartial({
          user: admin.publicKey,
          market: pdas.marketPda,
          userUsdc: adminUsdcAta,
          vault: pdas.vaultPda,
          yesMint: pdas.yesMintPda,
          noMint: pdas.noMintPda,
          userYes: userYes,
          userNo: userNo,
        })
        .rpc();
    }

    const usdcAfterMint = Number(
      (await getAccount(provider.connection, adminUsdcAta)).amount
    );
    expect(usdcBefore - usdcAfterMint).to.equal(10_000_000);

    // Settle as YesWins
    await program.methods
      .settleMarket({ yesWins: {} })
      .accountsPartial({
        admin: admin.publicKey,
        market: pdas.marketPda,
      })
      .rpc();

    // Redeem 10 Yes tokens (winner - gets USDC back)
    await program.methods
      .redeem(new anchor.BN(10))
      .accountsPartial({
        user: admin.publicKey,
        market: pdas.marketPda,
        userUsdc: adminUsdcAta,
        vault: pdas.vaultPda,
        tokenMint: pdas.yesMintPda,
        userToken: userYes,
      })
      .rpc();

    const usdcAfterYesRedeem = Number(
      (await getAccount(provider.connection, adminUsdcAta)).amount
    );
    expect(usdcAfterYesRedeem - usdcAfterMint).to.equal(10_000_000);

    // Redeem 10 No tokens (loser - gets 0 USDC)
    await program.methods
      .redeem(new anchor.BN(10))
      .accountsPartial({
        user: admin.publicKey,
        market: pdas.marketPda,
        userUsdc: adminUsdcAta,
        vault: pdas.vaultPda,
        tokenMint: pdas.noMintPda,
        userToken: userNo,
      })
      .rpc();

    const usdcAfterNoRedeem = Number(
      (await getAccount(provider.connection, adminUsdcAta)).amount
    );
    // Loser gets nothing
    expect(usdcAfterNoRedeem).to.equal(usdcAfterYesRedeem);

    // Vault should be empty
    const vaultAccount = await getAccount(
      provider.connection,
      pdas.vaultPda
    );
    expect(Number(vaultAccount.amount)).to.equal(0);

    // total_pairs_minted should be 0
    const marketAccount = await program.account.strikeMarket.fetch(
      pdas.marketPda
    );
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(0);
  });

  it("full lifecycle - No wins", async () => {
    const ticker = "GOOG";
    const strikePrice = new anchor.BN(150_000_000);
    const date = new anchor.BN(1700000003);
    const pdas = await createMarket(ticker, strikePrice, date);

    const userYes = getAssociatedTokenAddressSync(
      pdas.yesMintPda,
      admin.publicKey
    );
    const userNo = getAssociatedTokenAddressSync(
      pdas.noMintPda,
      admin.publicKey
    );

    // Mint 5 pairs
    for (let i = 0; i < 5; i++) {
      await program.methods
        .mintPair()
        .accountsPartial({
          user: admin.publicKey,
          market: pdas.marketPda,
          userUsdc: adminUsdcAta,
          vault: pdas.vaultPda,
          yesMint: pdas.yesMintPda,
          noMint: pdas.noMintPda,
          userYes: userYes,
          userNo: userNo,
        })
        .rpc();
    }

    // Settle as NoWins
    await program.methods
      .settleMarket({ noWins: {} })
      .accountsPartial({
        admin: admin.publicKey,
        market: pdas.marketPda,
      })
      .rpc();

    // Redeem 5 No tokens (winner)
    await program.methods
      .redeem(new anchor.BN(5))
      .accountsPartial({
        user: admin.publicKey,
        market: pdas.marketPda,
        userUsdc: adminUsdcAta,
        vault: pdas.vaultPda,
        tokenMint: pdas.noMintPda,
        userToken: userNo,
      })
      .rpc();

    // Vault should be empty
    const vaultAccount = await getAccount(
      provider.connection,
      pdas.vaultPda
    );
    expect(Number(vaultAccount.amount)).to.equal(0);

    const marketAccount = await program.account.strikeMarket.fetch(
      pdas.marketPda
    );
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(0);
  });

  it("burn_pair works on settled market too", async () => {
    // Create, mint, settle, then burn
    const ticker = "AMZN";
    const strikePrice = new anchor.BN(180_000_000);
    const date = new anchor.BN(1700000004);
    const pdas = await createMarket(ticker, strikePrice, date);

    const userYes = getAssociatedTokenAddressSync(
      pdas.yesMintPda,
      admin.publicKey
    );
    const userNo = getAssociatedTokenAddressSync(
      pdas.noMintPda,
      admin.publicKey
    );

    // Mint 3 pairs
    for (let i = 0; i < 3; i++) {
      await program.methods
        .mintPair()
        .accountsPartial({
          user: admin.publicKey,
          market: pdas.marketPda,
          userUsdc: adminUsdcAta,
          vault: pdas.vaultPda,
          yesMint: pdas.yesMintPda,
          noMint: pdas.noMintPda,
          userYes: userYes,
          userNo: userNo,
        })
        .rpc();
    }

    // Settle
    await program.methods
      .settleMarket({ yesWins: {} })
      .accountsPartial({
        admin: admin.publicKey,
        market: pdas.marketPda,
      })
      .rpc();

    // Burn 1 pair (should still work post-settlement)
    await program.methods
      .burnPair(new anchor.BN(1))
      .accountsPartial({
        user: admin.publicKey,
        market: pdas.marketPda,
        userUsdc: adminUsdcAta,
        vault: pdas.vaultPda,
        yesMint: pdas.yesMintPda,
        noMint: pdas.noMintPda,
        userYes: userYes,
        userNo: userNo,
      })
      .rpc();

    const vaultAccount = await getAccount(
      provider.connection,
      pdas.vaultPda
    );
    expect(Number(vaultAccount.amount)).to.equal(2_000_000);

    const marketAccount = await program.account.strikeMarket.fetch(
      pdas.marketPda
    );
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(2);
  });
});
