import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createMint,
  createAssociatedTokenAccount,
  createTransferInstruction,
  mintTo,
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

describe("meridian", () => {
  const supportedTickers = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
  const uniqueTestSeedBase =
    Math.floor(Date.now() / 1000) - 86_400 + Math.floor(Math.random() * 10_000);
  const walletPath = resolve(process.env.ANCHOR_WALLET || ".wallets/admin.json");
  const walletSecret = JSON.parse(readFileSync(walletPath, "utf-8"));
  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(Uint8Array.from(walletSecret))
  );
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(rpcUrl, "confirmed"),
    wallet,
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.Meridian as Program<Meridian>;
  const admin = provider.wallet;
  const methods = program.methods as any;

  let configPda: PublicKey;
  let configBump: number;
  let usdcMint: PublicKey;
  let mintAuthority: Keypair;
  let adminUsdcAta: PublicKey;

  function closeTimeAfter(date: anchor.BN, seconds = 3600) {
    return date.add(new anchor.BN(seconds));
  }

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
    return {
      marketPda,
      yesMintPda,
      noMintPda,
      vaultPda,
      orderBookPda,
      obUsdcVault,
      obYesVault,
    };
  }

  // Helper: create a strike market with oracle fields
  function normalizeTicker(ticker: string) {
    if (supportedTickers.includes(ticker)) {
      return ticker;
    }
    let sum = 0;
    for (const ch of ticker) sum += ch.charCodeAt(0);
    return supportedTickers[sum % supportedTickers.length];
  }

  async function createMarket(
    ticker: string,
    strikePrice: anchor.BN,
    date: anchor.BN,
    closeTime?: anchor.BN
  ) {
    const normalizedTicker = normalizeTicker(ticker);
    const pdas = deriveMarketPdas(normalizedTicker, strikePrice, date);
    await program.methods
      .createStrikeMarket(
        normalizedTicker,
        strikePrice,
        date,
        closeTime ?? closeTimeAfter(date)
      )
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

  async function createFundedUser(usdcAmount = 20_000_000) {
    const user = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      user.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const userUsdc = await createAssociatedTokenAccount(
      provider.connection,
      mintAuthority,
      usdcMint,
      user.publicKey
    );
    await mintUsdc(userUsdc, usdcAmount);
    return { user, userUsdc };
  }

  async function tokenAmount(account: PublicKey) {
    return Number((await getAccount(provider.connection, account)).amount);
  }

  function expectIncrease(before: number, after: number, expectedDelta: number) {
    expect(after - before).to.equal(expectedDelta);
  }

  function expectDecrease(before: number, after: number, expectedDelta: number) {
    expect(before - after).to.equal(expectedDelta);
  }

  function tokenAccountsFor(
    owner: PublicKey,
    market: ReturnType<typeof deriveMarketPdas>
  ) {
    return {
      userYes: getAssociatedTokenAddressSync(market.yesMintPda, owner),
      userNo: getAssociatedTokenAddressSync(market.noMintPda, owner),
    };
  }

  function userTokenAccounts(market: ReturnType<typeof deriveMarketPdas>) {
    return tokenAccountsFor(admin.publicKey, market);
  }

  function deriveOrderBookPdas(marketPda: PublicKey) {
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
    return { orderBookPda, obUsdcVault, obYesVault };
  }

  async function initOrderBookForMarket(
    marketPda: PublicKey,
    yesMintPda: PublicKey
  ) {
    const obPdas = deriveOrderBookPdas(marketPda);
    const existing = await program.account.orderBook.fetchNullable(obPdas.orderBookPda);
    if (existing) {
      return obPdas;
    }
    await methods
      .initializeOrderBook()
      .accountsPartial({
        admin: admin.publicKey,
        market: marketPda,
        yesMint: yesMintPda,
        usdcMint,
      })
      .rpc();
    return obPdas;
  }

  async function mintPairForAdmin(
    market: ReturnType<typeof deriveMarketPdas>,
    amount = 1
  ) {
    return mintPairForUser(admin.publicKey, adminUsdcAta, market, amount);
  }

  async function mintPairForUser(
    user: PublicKey,
    userUsdcAta: PublicKey,
    market: ReturnType<typeof deriveMarketPdas>,
    amount = 1,
    signers?: Keypair[]
  ) {
    const { userYes: ownerYes, userNo: ownerNo } = tokenAccountsFor(user, market);
    const tx = methods
      .mintPair(new anchor.BN(amount))
      .accountsPartial({
        user,
        market: market.marketPda,
        userUsdc: userUsdcAta,
        vault: market.vaultPda,
        yesMint: market.yesMintPda,
        noMint: market.noMintPda,
        userYes: ownerYes,
        userNo: ownerNo,
      });
    if (signers) {
      await tx.signers(signers).rpc();
    } else {
      await tx.rpc();
    }
    return { userYes: ownerYes, userNo: ownerNo };
  }

  async function burnPairForUser(
    user: PublicKey,
    userUsdcAta: PublicKey,
    market: ReturnType<typeof deriveMarketPdas>,
    amount = 1,
    signers?: Keypair[]
  ) {
    const { userYes: ownerYes, userNo: ownerNo } = tokenAccountsFor(user, market);
    const tx = methods
      .redeem(new anchor.BN(amount))
      .accountsPartial({
        user,
        market: market.marketPda,
        userUsdc: userUsdcAta,
        vault: market.vaultPda,
        tokenMint: market.yesMintPda,
        userToken: ownerYes,
      })
      .remainingAccounts([
        { pubkey: market.noMintPda, isWritable: true, isSigner: false },
        { pubkey: ownerNo, isWritable: true, isSigner: false },
      ]);
    if (signers) {
      await tx.signers(signers).rpc();
    } else {
      await tx.rpc();
    }
    return { userYes: ownerYes, userNo: ownerNo };
  }

  async function freezeMarket(market: ReturnType<typeof deriveMarketPdas>) {
    await methods
      .freezeMarket()
      .accountsPartial({
        authority: admin.publicKey,
        config: configPda,
        market: market.marketPda,
      })
      .rpc();
  }

  async function pauseProtocol(adminSigner: PublicKey = admin.publicKey, signers?: Keypair[]) {
    const tx = program.methods.pause().accountsPartial({ admin: adminSigner });
    if (signers) {
      await tx.signers(signers).rpc();
    } else {
      await tx.rpc();
    }
  }

  async function unpauseProtocol(adminSigner: PublicKey = admin.publicKey, signers?: Keypair[]) {
    const tx = program.methods.unpause().accountsPartial({ admin: adminSigner });
    if (signers) {
      await tx.signers(signers).rpc();
    } else {
      await tx.rpc();
    }
  }

  async function adminSettleMarket(
    market: ReturnType<typeof deriveMarketPdas>,
    price: anchor.BN
  ) {
    await freezeMarket(market);
    await methods
      .adminSettle(price)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        market: market.marketPda,
      })
      .remainingAccounts(settlementProofAccounts(market))
      .rpc();
  }

  function settlementProofAccounts(market: {
    orderBookPda: PublicKey;
  }) {
    return [
      { pubkey: market.orderBookPda, isWritable: true, isSigner: false },
    ];
  }

  async function settleWithOrderBookProof(
    market: ReturnType<typeof deriveMarketPdas> & {
      orderBookPda: PublicKey;
      obUsdcVault: PublicKey;
      obYesVault: PublicKey;
    },
    price: anchor.BN
  ) {
    await methods
      .adminSettle(price)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        market: market.marketPda,
      })
      .remainingAccounts(settlementProofAccounts(market))
      .rpc();
  }

  async function unwindOrderForSettlement(
    market: ReturnType<typeof deriveMarketPdas> & {
      orderBookPda: PublicKey;
      obUsdcVault: PublicKey;
      obYesVault: PublicKey;
    },
    orderId: anchor.BN | number,
    refundUsdcDestination: PublicKey,
    refundYesDestination: PublicKey,
    signer?: Keypair
  ) {
    const tx = methods
      .unwindOrder(orderId instanceof anchor.BN ? orderId : new anchor.BN(orderId))
      .accountsPartial({
        authority: signer?.publicKey ?? admin.publicKey,
        market: market.marketPda,
        orderBook: market.orderBookPda,
        obUsdcVault: market.obUsdcVault,
        obYesVault: market.obYesVault,
        refundUsdcDestination,
        refundYesDestination,
      });
    if (signer) {
      await tx.signers([signer]).rpc();
    } else {
      await tx.rpc();
    }
  }

  async function placeBid(
    market: ReturnType<typeof deriveMarketPdas> & {
      orderBookPda: PublicKey;
      obUsdcVault: PublicKey;
      obYesVault: PublicKey;
    },
    user: PublicKey,
    userUsdc: PublicKey,
    userYes: PublicKey,
    price: number,
    quantity: number,
    options?: {
      signers?: Keypair[];
    }
  ) {
    const tx = program.methods
      .placeOrder({ bid: {} }, new anchor.BN(price), new anchor.BN(quantity))
      .accountsPartial({
        user,
        market: market.marketPda,
        orderBook: market.orderBookPda,
        obUsdcVault: market.obUsdcVault,
        obYesVault: market.obYesVault,
        userUsdc,
        userYes,
      });
    if (options?.signers) {
      await tx.signers(options.signers).rpc();
    } else {
      await tx.rpc();
    }
  }

  async function placeAsk(
    market: ReturnType<typeof deriveMarketPdas> & {
      orderBookPda: PublicKey;
      obUsdcVault: PublicKey;
      obYesVault: PublicKey;
    },
    user: PublicKey,
    userUsdc: PublicKey,
    userYes: PublicKey,
    price: number,
    quantity: number,
    options?: {
      signers?: Keypair[];
    }
  ) {
    const tx = program.methods
      .placeOrder({ ask: {} }, new anchor.BN(price), new anchor.BN(quantity))
      .accountsPartial({
        user,
        market: market.marketPda,
        orderBook: market.orderBookPda,
        obUsdcVault: market.obUsdcVault,
        obYesVault: market.obYesVault,
        userUsdc,
        userYes,
      });
    if (options?.signers) {
      await tx.signers(options.signers).rpc();
    } else {
      await tx.rpc();
    }
  }

  async function buyYes(
    market: ReturnType<typeof deriveMarketPdas> & {
      orderBookPda: PublicKey;
      obUsdcVault: PublicKey;
      obYesVault: PublicKey;
    },
    user: PublicKey,
    userUsdc: PublicKey,
    userYes: PublicKey,
    maxPrice: number,
    amount: number,
    options?: {
      signers?: Keypair[];
    }
  ) {
    const tx = methods
      .buyYes(new anchor.BN(amount), new anchor.BN(maxPrice))
      .accountsPartial({
        user,
        config: configPda,
        market: market.marketPda,
        userUsdc,
        yesMint: market.yesMintPda,
        userYes,
        orderBook: market.orderBookPda,
        obUsdcVault: market.obUsdcVault,
        obYesVault: market.obYesVault,
      });
    if (options?.signers) {
      await tx.signers(options.signers).rpc();
    } else {
      await tx.rpc();
    }
  }

  async function sellYes(
    market: ReturnType<typeof deriveMarketPdas> & {
      orderBookPda: PublicKey;
      obUsdcVault: PublicKey;
      obYesVault: PublicKey;
    },
    user: PublicKey,
    userUsdc: PublicKey,
    userYes: PublicKey,
    minPrice: number,
    amount: number,
    options?: {
      signers?: Keypair[];
    }
  ) {
    const tx = methods
      .sellYes(new anchor.BN(amount), new anchor.BN(minPrice))
      .accountsPartial({
        user,
        config: configPda,
        market: market.marketPda,
        userUsdc,
        userYes,
        orderBook: market.orderBookPda,
        obUsdcVault: market.obUsdcVault,
        obYesVault: market.obYesVault,
      });
    if (options?.signers) {
      await tx.signers(options.signers).rpc();
    } else {
      await tx.rpc();
    }
  }

  async function claimFills(
    market: ReturnType<typeof deriveMarketPdas> & {
      orderBookPda: PublicKey;
      obUsdcVault: PublicKey;
      obYesVault: PublicKey;
    },
    owner: PublicKey,
    ownerUsdc: PublicKey,
    ownerYes: PublicKey,
    signers?: Keypair[]
  ) {
    const tx = methods
      .claimFills()
      .accountsPartial({
        payer: admin.publicKey,
        market: market.marketPda,
        orderBook: market.orderBookPda,
        obUsdcVault: market.obUsdcVault,
        obYesVault: market.obYesVault,
        owner,
        ownerUsdc,
        ownerYes,
      });
    if (signers) {
      await tx.signers(signers).rpc();
    } else {
      await tx.rpc();
    }
  }

  async function buyNo(
    market: ReturnType<typeof deriveMarketPdas> & {
      orderBookPda: PublicKey;
      obUsdcVault: PublicKey;
      obYesVault: PublicKey;
    },
    user: PublicKey,
    userUsdc: PublicKey,
    userYes: PublicKey,
    userNo: PublicKey,
    maxNetCost: number,
    amount: number,
    options?: {
      signers?: Keypair[];
    }
  ) {
    const mintIx = await methods
      .mintPair(new anchor.BN(amount))
      .accountsPartial({
        user,
        market: market.marketPda,
        userUsdc,
        vault: market.vaultPda,
        yesMint: market.yesMintPda,
        noMint: market.noMintPda,
        userYes,
        userNo,
      })
      .instruction();

    const sellIx = await methods
      .sellYes(new anchor.BN(amount), new anchor.BN(maxNetCost))
      .accountsPartial({
        user,
        config: configPda,
        market: market.marketPda,
        userUsdc,
        userYes,
        orderBook: market.orderBookPda,
        obUsdcVault: market.obUsdcVault,
        obYesVault: market.obYesVault,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(mintIx, sellIx);
    await provider.sendAndConfirm(tx, options?.signers ?? []);
  }

  async function sellNo(
    market: ReturnType<typeof deriveMarketPdas> & {
      orderBookPda: PublicKey;
      obUsdcVault: PublicKey;
      obYesVault: PublicKey;
    },
    user: PublicKey,
    userUsdc: PublicKey,
    userYes: PublicKey,
    userNo: PublicKey,
    minNetPrice: number,
    amount: number,
    options?: {
      signers?: Keypair[];
    }
  ) {
    const buyIx = await methods
      .buyYes(new anchor.BN(amount), new anchor.BN(minNetPrice))
      .accountsPartial({
        user,
        config: configPda,
        market: market.marketPda,
        userUsdc,
        yesMint: market.yesMintPda,
        userYes,
        orderBook: market.orderBookPda,
        obUsdcVault: market.obUsdcVault,
        obYesVault: market.obYesVault,
      })
      .instruction();

    const redeemIx = await methods
      .redeem(new anchor.BN(amount))
      .accountsPartial({
        user,
        market: market.marketPda,
        userUsdc,
        vault: market.vaultPda,
        tokenMint: market.yesMintPda,
        userToken: userYes,
      })
      .remainingAccounts([
        { pubkey: market.noMintPda, isWritable: true, isSigner: false },
        { pubkey: userNo, isWritable: true, isSigner: false },
      ])
      .instruction();

    const tx = new anchor.web3.Transaction().add(buyIx, redeemIx);
    await provider.sendAndConfirm(tx, options?.signers ?? []);
  }

  async function redeemForUser(
    market: ReturnType<typeof deriveMarketPdas>,
    user: PublicKey,
    userUsdc: PublicKey,
    tokenMint: PublicKey,
    userToken: PublicKey,
    amount: number,
    signers?: Keypair[],
    remainingAccounts?: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[]
  ) {
    const tx = methods
      .redeem(new anchor.BN(amount))
      .accountsPartial({
        user,
        market: market.marketPda,
        userUsdc,
        vault: market.vaultPda,
        tokenMint,
        userToken,
      });
    if (remainingAccounts) {
      tx.remainingAccounts(remainingAccounts);
    }
    if (signers) {
      await tx.signers(signers).rpc();
    } else {
      await tx.rpc();
    }
  }

  async function transferTokens(
    source: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
    amount: number,
    signers?: Keypair[]
  ) {
    const tx = new anchor.web3.Transaction().add(
      createTransferInstruction(source, destination, owner, amount)
    );
    await provider.sendAndConfirm(tx, signers ?? []);
  }

  async function getCurrentUnixTimestamp(): Promise<number> {
    const slot = await provider.connection.getSlot("confirmed");
    const blockTime = await provider.connection.getBlockTime(slot);
    if (blockTime === null) {
      throw new Error("Failed to fetch block time");
    }
    return blockTime;
  }

  async function ensureConfigInitialized() {
    const existing = await program.account.globalConfig.fetchNullable(configPda);
    if (existing) {
      return existing;
    }

    await program.methods
      .initializeConfig()
      .accountsPartial({
        admin: admin.publicKey,
      })
      .rpc();

    return program.account.globalConfig.fetch(configPda);
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

    await ensureConfigInitialized();
  });

  it("initializes global config", async () => {
    const configAccount = await ensureConfigInitialized();
    expect(configAccount.admin.toBase58()).to.equal(
      admin.publicKey.toBase58()
    );
    expect(configAccount.paused).to.equal(false);
    expect(configAccount.bump).to.equal(configBump);
    expect(configAccount.oraclePolicies).to.have.length(7);
    expect(
      configAccount.oraclePolicies.find((policy: any) => policy.ticker === "META")
    ).to.deep.include({
      ticker: "META",
      confidenceFilterBps: 100,
      maxPriceStalenessSecs: new anchor.BN(300),
    });
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
    expect(marketAccount.closeTime.toNumber()).to.equal(
      closeTimeAfter(sharedDate).toNumber()
    );
    expect(marketAccount.orderBook.toBase58()).to.equal(
      sharedMarket.orderBookPda.toBase58()
    );
    expect(marketAccount.obUsdcVault.toBase58()).to.equal(
      sharedMarket.obUsdcVault.toBase58()
    );
    expect(marketAccount.obYesVault.toBase58()).to.equal(
      sharedMarket.obYesVault.toBase58()
    );
  });

  it("rejects create_strike_market for unsupported tickers at the on-chain config boundary", async () => {
    const date = new anchor.BN(1700000001);
    const unsupportedTicker = "QQQ";
    const strikePrice = new anchor.BN(500_000_000);

    try {
      await program.methods
        .createStrikeMarket(unsupportedTicker, strikePrice, date, closeTimeAfter(date))
        .accountsPartial({
          admin: admin.publicKey,
          usdcMint,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("UnsupportedTicker");
    }
  });

  it("rejects create_strike_market from a non-admin signer", async () => {
    const { user } = await createFundedUser();
    const date = new anchor.BN(1700000002);

    try {
      await program.methods
        .createStrikeMarket("AAPL", new anchor.BN(510_000_000), date, closeTimeAfter(date))
        .accountsPartial({
          admin: user.publicKey,
          usdcMint,
        })
        .signers([user])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|2012/);
    }
  });

  it("keeps legacy lifecycle instructions out of the generated IDL and client methods", async () => {
    const instructionNames = program.idl.instructions.map((ix) => ix.name);

    expect(instructionNames).to.not.include("buyNo");
    expect(instructionNames).to.not.include("sellNo");
    expect(instructionNames).to.not.include("burnPair");
    expect((methods as Record<string, unknown>).buyNo).to.equal(undefined);
    expect((methods as Record<string, unknown>).sellNo).to.equal(undefined);
    expect((methods as Record<string, unknown>).burnPair).to.equal(undefined);
  });

  it("add_strike creates another admin-only market with full trading accounts", async () => {
    const ticker = "AAPL";
    const strikePrice = new anchor.BN(520_000_000);
    const date = new anchor.BN(1700000003);
    const pdas = deriveMarketPdas(ticker, strikePrice, date);

    await program.methods
      .addStrike(ticker, strikePrice, date, closeTimeAfter(date))
      .accountsPartial({
        admin: admin.publicKey,
        usdcMint,
      })
      .rpc();

    const marketAccount = await program.account.strikeMarket.fetch(pdas.marketPda);
    expect(marketAccount.orderBook.toBase58()).to.equal(pdas.orderBookPda.toBase58());
    expect(marketAccount.obUsdcVault.toBase58()).to.equal(pdas.obUsdcVault.toBase58());
    expect(marketAccount.obYesVault.toBase58()).to.equal(pdas.obYesVault.toBase58());
  });

  it("mints a pair", async () => {
    const { userYes, userNo } = await mintPairForAdmin(sharedMarket, 1);

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
    const { userYes, userNo } = userTokenAccounts(sharedMarket);

    for (let i = 0; i < 4; i++) {
      await mintPairForAdmin(sharedMarket, 1);
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
    const { userYes, userNo } = await burnPairForUser(
      admin.publicKey,
      adminUsdcAta,
      sharedMarket,
      2
    );

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

  it("mints 10 pairs in a single batch call (amount=10)", async () => {
    const { userYes, userNo } = await mintPairForAdmin(sharedMarket, 10);

    // Vault: 3 remaining + 10 new = 13 pairs * 1_000_000 = 13_000_000
    const vaultAccount = await getAccount(
      provider.connection,
      sharedMarket.vaultPda
    );
    expect(Number(vaultAccount.amount)).to.equal(13_000_000);

    // User token balances: 3 + 10 = 13
    const yesAccount = await getAccount(provider.connection, userYes);
    expect(Number(yesAccount.amount)).to.equal(13);
    const noAccount = await getAccount(provider.connection, userNo);
    expect(Number(noAccount.amount)).to.equal(13);

    const marketAccount = await program.account.strikeMarket.fetch(
      sharedMarket.marketPda
    );
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(13);
  });

  it("rejects mint_pair with amount=0 (InvalidAmount)", async () => {
    try {
      await mintPairForAdmin(sharedMarket, 0);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidAmount");
    }
  });

  it("rejects pre-settlement complete-set redeem when amount exceeds token balance", async () => {
    try {
      await burnPairForUser(admin.publicKey, adminUsdcAta, sharedMarket, 999);
      expect.fail("Should have thrown");
    } catch (err: any) {
      // SPL token burn fails with insufficient funds before any USDC transfer
      expect(err).to.exist;
    }
  });

  it("rejects mint on settled market", async () => {
    await adminSettleMarket(sharedMarket, new anchor.BN(680_000_000));

    try {
      await mintPairForAdmin(sharedMarket, 1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketAlreadySettled");
    }
  });

  it("rejects unsettled redeem without the counterpart token accounts", async () => {
    // Create a new unsettled market
    const ticker = "AAPL";
    const strikePrice = new anchor.BN(200_000_000);
    const date = new anchor.BN(1700000001);
    const pdas = await createMarket(ticker, strikePrice, date);

    // Mint a pair so we have tokens to try redeeming
    const { userYes } = await mintPairForAdmin(pdas, 1);

    try {
      await redeemForUser(
        pdas,
        admin.publicKey,
        adminUsdcAta,
        pdas.yesMintPda,
        userYes,
        1
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MissingCounterpartyAccount");
    }
  });

  it("allows pre-settlement complete-set redeem with No as the primary token account", async () => {
    const ticker = "NFLX";
    const strikePrice = new anchor.BN(210_000_000);
    const date = new anchor.BN(17000000015);
    const pdas = await createMarket(ticker, strikePrice, date);

    const { userYes, userNo } = await mintPairForAdmin(pdas, 2);
    const usdcBefore = Number((await getAccount(provider.connection, adminUsdcAta)).amount);

    await redeemForUser(
      pdas,
      admin.publicKey,
      adminUsdcAta,
      pdas.noMintPda,
      userNo,
      1,
      undefined,
      [
        { pubkey: pdas.yesMintPda, isWritable: true, isSigner: false },
        { pubkey: userYes, isWritable: true, isSigner: false },
      ]
    );

    const usdcAfter = Number((await getAccount(provider.connection, adminUsdcAta)).amount);
    const yesAfter = Number((await getAccount(provider.connection, userYes)).amount);
    const noAfter = Number((await getAccount(provider.connection, userNo)).amount);
    const vaultAfter = Number((await getAccount(provider.connection, pdas.vaultPda)).amount);
    const marketAccount = await program.account.strikeMarket.fetch(pdas.marketPda);

    expect(usdcAfter - usdcBefore).to.equal(1_000_000);
    expect(yesAfter).to.equal(1);
    expect(noAfter).to.equal(1);
    expect(vaultAfter).to.equal(1_000_000);
    expect(marketAccount.totalPairsMinted.toNumber()).to.equal(1);
  });

  it("rejects pre-settlement complete-set redeem when the counterpart token account is owned by someone else", async () => {
    const ticker = "ORCL";
    const strikePrice = new anchor.BN(220_000_000);
    const date = new anchor.BN(17000000016);
    const pdas = await createMarket(ticker, strikePrice, date);

    const { userYes } = await mintPairForAdmin(pdas, 1);
    const funded = await createFundedUser(1_000_000);
    const otherNo = await createAssociatedTokenAccount(
      provider.connection,
      funded.user,
      pdas.noMintPda,
      funded.user.publicKey
    );

    try {
      await redeemForUser(
        pdas,
        admin.publicKey,
        adminUsdcAta,
        pdas.yesMintPda,
        userYes,
        1,
        undefined,
        [
          { pubkey: pdas.noMintPda, isWritable: true, isSigner: false },
          { pubkey: otherNo, isWritable: true, isSigner: false },
        ]
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidCounterpartyAccount");
    }
  });

  it("full lifecycle - Yes wins (at-or-above rule)", async () => {
    const ticker = "MSFT";
    const strikePrice = new anchor.BN(400_000_000);
    const date = new anchor.BN(1700000002);
    const pdas = await createMarket(ticker, strikePrice, date);

    const { userYes, userNo } = userTokenAccounts(pdas);

    // Record USDC balance before
    const usdcBefore = Number(
      (await getAccount(provider.connection, adminUsdcAta)).amount
    );

    // Mint 10 pairs
    for (let i = 0; i < 10; i++) {
      await mintPairForAdmin(pdas, 1);
    }

    const usdcAfterMint = Number(
      (await getAccount(provider.connection, adminUsdcAta)).amount
    );
    expect(usdcBefore - usdcAfterMint).to.equal(10_000_000);

    // Admin settle with price exactly at strike (at-or-above -> YesWins)
    await adminSettleMarket(pdas, new anchor.BN(400_000_000));

    // Redeem 10 Yes tokens (winner - gets USDC back)
    await redeemForUser(
      pdas,
      admin.publicKey,
      adminUsdcAta,
      pdas.yesMintPda,
      userYes,
      10
    );

    const usdcAfterYesRedeem = Number(
      (await getAccount(provider.connection, adminUsdcAta)).amount
    );
    expect(usdcAfterYesRedeem - usdcAfterMint).to.equal(10_000_000);

    // Redeem 10 No tokens (loser - gets 0 USDC)
    await redeemForUser(
      pdas,
      admin.publicKey,
      adminUsdcAta,
      pdas.noMintPda,
      userNo,
      10
    );

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

    const { userNo } = userTokenAccounts(pdas);

    // Mint 5 pairs
    for (let i = 0; i < 5; i++) {
      await mintPairForAdmin(pdas, 1);
    }

    // Admin settle with price below strike -> NoWins
    await adminSettleMarket(pdas, new anchor.BN(140_000_000));

    // Redeem 5 No tokens (winner)
    await redeemForUser(
      pdas,
      admin.publicKey,
      adminUsdcAta,
      pdas.noMintPda,
      userNo,
      5
    );

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

  it("redeems winning tokens after settlement while pre-settlement complete-set exits use redeem", async () => {
    // Create, mint, settle, then burn
    const ticker = "AMZN";
    const strikePrice = new anchor.BN(180_000_000);
    const date = new anchor.BN(1700000004);
    const pdas = await createMarket(ticker, strikePrice, date);

    // Mint 3 pairs
    for (let i = 0; i < 3; i++) {
      await mintPairForAdmin(pdas, 1);
    }

    // Admin settle
    await adminSettleMarket(pdas, new anchor.BN(200_000_000));

    // Redeem 1 winning Yes token post-settlement.
    await burnPairForUser(admin.publicKey, adminUsdcAta, pdas, 1);

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

  it("admin settle at strike exactly -> YesWins (at-or-above)", async () => {
    const ticker = "NVDA";
    const strikePrice = new anchor.BN(500_000_000);
    const date = new anchor.BN(1700000005);
    const pdas = await createMarket(ticker, strikePrice, date);

    await adminSettleMarket(pdas, new anchor.BN(500_000_000));

    const marketAccount = await program.account.strikeMarket.fetch(
      pdas.marketPda
    );
    expect(marketAccount.outcome).to.deep.equal({ yesWins: {} });
    expect(marketAccount.settledAt).to.not.be.null;
  });

  it("admin settle below strike -> NoWins", async () => {
    const ticker = "TSLA";
    const strikePrice = new anchor.BN(300_000_000);
    const date = new anchor.BN(1700000006);
    const pdas = await createMarket(ticker, strikePrice, date);

    await adminSettleMarket(pdas, new anchor.BN(299_999_999));

    const marketAccount = await program.account.strikeMarket.fetch(
      pdas.marketPda
    );
    expect(marketAccount.outcome).to.deep.equal({ noWins: {} });
  });

  it("rejects admin settle before 1hr delay", async () => {
    const ticker = "AAPL";
    const strikePrice = new anchor.BN(600_000_000);
    const date = new anchor.BN(1700000007);
    const now = await getCurrentUnixTimestamp();
    const recentCloseTime = new anchor.BN(now - 60);
    const pdas = await createMarket(
      ticker,
      strikePrice,
      date,
      recentCloseTime
    );

    await freezeMarket(pdas);

    try {
      await program.methods
        .adminSettle(new anchor.BN(650_000_000))
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          market: pdas.marketPda,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("AdminSettleTooEarly");
    }
  });

  it("rejects admin settle on already settled market", async () => {
    const ticker = "META";
    const strikePrice = new anchor.BN(100_000_000);
    const date = new anchor.BN(1700000008);
    const pdas = await createMarket(ticker, strikePrice, date);

    // Settle once
    await adminSettleMarket(pdas, new anchor.BN(110_000_000));

    // Try to settle again
    try {
      await program.methods
        .adminSettle(new anchor.BN(90_000_000))
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          market: pdas.marketPda,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("MarketAlreadySettled");
    }
  });

  // ═══════════════════════════════════════════════════════════════
  //  ORDER BOOK (CLOB) TESTS
  // ═══════════════════════════════════════════════════════════════

  describe("order book", () => {
    const connection = provider.connection;
    let userB: Keypair;
    let userBUsdc: PublicKey;

    // Unique market counter to avoid collisions
    let obMarketIdx = uniqueTestSeedBase;
    function nextDate() {
      return new anchor.BN(obMarketIdx++);
    }

    // Create a market + order book in one call
    async function createMarketWithOB(ticker: string, strikePrice: anchor.BN) {
      const date = nextDate();
      const pdas = await createMarket(ticker, strikePrice, date);
      return { ...pdas, date };
    }

    // Mint pairs for a user (admin or userB)
    async function mintPairsFor(
      pdas: ReturnType<typeof deriveMarketPdas>,
      userKey: PublicKey,
      userUsdcAta: PublicKey,
      count: number,
      signers?: Keypair[]
    ) {
      const userYes = getAssociatedTokenAddressSync(pdas.yesMintPda, userKey);
      const userNo = getAssociatedTokenAddressSync(pdas.noMintPda, userKey);

      const tx = program.methods
        .mintPair(new anchor.BN(count))
        .accountsPartial({
          user: userKey,
          market: pdas.marketPda,
          userUsdc: userUsdcAta,
          vault: pdas.vaultPda,
          yesMint: pdas.yesMintPda,
          noMint: pdas.noMintPda,
          userYes,
          userNo,
        });
      if (signers) {
        await tx.signers(signers).rpc();
      } else {
        await tx.rpc();
      }
    }

    before(async () => {
      userB = Keypair.generate();
      const sig = await connection.requestAirdrop(
        userB.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);
      userBUsdc = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        usdcMint,
        userB.publicKey
      );
      await mintUsdc(userBUsdc, 50_000_000); // 50 USDC
    });

    // ── initialize_order_book ──────────────────────────────────

    it("create_strike_market initializes order book + escrow vaults", async () => {
      const date = nextDate();
      const pdas = await createMarket("OB1", new anchor.BN(100_000_000), date);

      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(market.orderBook.toBase58()).to.equal(pdas.orderBookPda.toBase58());
      expect(market.obUsdcVault.toBase58()).to.equal(pdas.obUsdcVault.toBase58());
      expect(market.obYesVault.toBase58()).to.equal(pdas.obYesVault.toBase58());

      const ob = await program.account.orderBook.fetch(pdas.orderBookPda);
      expect(ob.market.toBase58()).to.equal(pdas.marketPda.toBase58());
      expect(ob.bidCount).to.equal(0);
      expect(ob.askCount).to.equal(0);
      expect(ob.nextOrderId.toNumber()).to.equal(1);

      // Vaults exist and are empty
      const usdcVault = await getAccount(connection, pdas.obUsdcVault);
      expect(Number(usdcVault.amount)).to.equal(0);
      const yesVault = await getAccount(connection, pdas.obYesVault);
      expect(Number(yesVault.amount)).to.equal(0);
    });

    // ── place_order - resting (no match) ───────────────────────

    it("places a resting bid (no match)", async () => {
      const m = await createMarketWithOB("OB3", new anchor.BN(100_000_000));
      // Mint 1 pair so admin's Yes ATA exists (place_order requires initialized user_yes)
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      const usdcBefore = await tokenAmount(adminUsdcAta);

      await placeBid(m, admin.publicKey, adminUsdcAta, adminYes, 500_000, 3);

      // Verify USDC escrowed: 3 * 500_000 = 1_500_000
      const usdcAfter = await tokenAmount(adminUsdcAta);
      expect(usdcBefore - usdcAfter).to.equal(1_500_000);

      const ob = await program.account.orderBook.fetch(m.orderBookPda);
      expect(ob.bidCount).to.equal(1);
      expect(ob.askCount).to.equal(0);
      expect(ob.bids[0].price.toNumber()).to.equal(500_000);
      expect(ob.bids[0].quantity.toNumber()).to.equal(3);
      expect(ob.bids[0].owner.toBase58()).to.equal(admin.publicKey.toBase58());
    });

    it("places a resting ask (no match)", async () => {
      const m = await createMarketWithOB("OB4", new anchor.BN(100_000_000));

      // Mint 2 pairs so admin has Yes tokens
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 2);

      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);
      const yesBefore = await tokenAmount(adminYes);

      await placeAsk(m, admin.publicKey, adminUsdcAta, adminYes, 700_000, 2);

      // 2 Yes tokens escrowed
      const yesAfter = await tokenAmount(adminYes);
      expect(yesBefore - yesAfter).to.equal(2);

      const ob = await program.account.orderBook.fetch(m.orderBookPda);
      expect(ob.askCount).to.equal(1);
      expect(ob.bidCount).to.equal(0);
      expect(ob.asks[0].price.toNumber()).to.equal(700_000);
      expect(ob.asks[0].quantity.toNumber()).to.equal(2);
    });

    // ── place_order - crossing rejected in favor of trade paths ─────────────

    it("crossing bid is rejected and must use buy_yes", async () => {
      const m = await createMarketWithOB("OB5", new anchor.BN(100_000_000));

      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 2);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      await placeAsk(m, admin.publicKey, adminUsdcAta, adminYes, 500_000, 2);

      await mintUsdc(userBUsdc, 5_000_000);
      const userBYes = await createAssociatedTokenAccount(
        connection,
        userB,
        m.yesMintPda,
        userB.publicKey
      );

      try {
        await placeBid(m, userB.publicKey, userBUsdc, userBYes, 600_000, 3, {
          signers: [userB],
        });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
      }
    });

    it("crossing bid rejects before counterparty-account validation", async () => {
      const m = await createMarketWithOB("OB_M", new anchor.BN(100_000_000));

      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      await placeAsk(m, admin.publicKey, adminUsdcAta, adminYes, 500_000, 1);

      await mintUsdc(userBUsdc, 1_000_000);
      const userBYes = await createAssociatedTokenAccount(
        connection,
        userB,
        m.yesMintPda,
        userB.publicKey
      );

      try {
        await placeBid(m, userB.publicKey, userBUsdc, userBYes, 500_000, 1, {
          signers: [userB],
        });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
      }
    });

    it("crossing bid ignores attacker-controlled remaining accounts and rejects early", async () => {
      const m = await createMarketWithOB("OB_M2", new anchor.BN(100_000_000));

      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      await placeAsk(m, admin.publicKey, adminUsdcAta, adminYes, 500_000, 1);

      const userBYes = await createAssociatedTokenAccount(
        connection,
        userB,
        m.yesMintPda,
        userB.publicKey
      );
      const adminUsdcBefore = await tokenAmount(adminUsdcAta);
      const userBUsdcBefore = await tokenAmount(userBUsdc);

      try {
        await placeBid(m, userB.publicKey, userBUsdc, userBYes, 500_000, 1, {
          signers: [userB],
        });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
      }

      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const userBYesAfter = await tokenAmount(userBYes);
      expect(adminUsdcAfter).to.equal(adminUsdcBefore);
      expect(userBUsdcAfter).to.equal(userBUsdcBefore);
      expect(userBYesAfter).to.equal(0);
    });

    // ── place_order - partial fill ─────────────────────────────

    it("crossing partial-fill attempts are rejected and must use dedicated taker flows", async () => {
      const m = await createMarketWithOB("OB6", new anchor.BN(100_000_000));

      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 5);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      await placeAsk(m, admin.publicKey, adminUsdcAta, adminYes, 400_000, 5);

      await mintUsdc(userBUsdc, 2_000_000);
      const userBYes = await createAssociatedTokenAccount(
        connection,
        userB,
        m.yesMintPda,
        userB.publicKey
      );

      try {
        await placeBid(m, userB.publicKey, userBUsdc, userBYes, 400_000, 2, {
          signers: [userB],
        });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
      }
    });

    // ── place_order - market orders ────────────────────────────

    it("market-style bid via place_order is rejected and must use buy_yes", async () => {
      const m = await createMarketWithOB("OB7", new anchor.BN(100_000_000));

      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 3);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      await placeAsk(m, admin.publicKey, adminUsdcAta, adminYes, 300_000, 1);

      await placeAsk(m, admin.publicKey, adminUsdcAta, adminYes, 600_000, 2);

      await mintUsdc(userBUsdc, 5_000_000);
      const userBYes = await createAssociatedTokenAccount(
        connection,
        userB,
        m.yesMintPda,
        userB.publicKey
      );

      try {
        await placeBid(m, userB.publicKey, userBUsdc, userBYes, 999_999, 3, {
          signers: [userB],
        });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("CrossingOrdersUseDedicatedPath");
      }
    });

    // ── cancel_order - owner cancel ────────────────────────────

    it("cancels a resting bid and refunds USDC", async () => {
      const m = await createMarketWithOB("OB8", new anchor.BN(100_000_000));
      // Mint 1 pair so admin's Yes ATA exists (place_order requires initialized user_yes)
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      const usdcBefore = await tokenAmount(adminUsdcAta);

      await placeBid(m, admin.publicKey, adminUsdcAta, adminYes, 500_000, 4);

      const ob = await program.account.orderBook.fetch(m.orderBookPda);
      const orderId = ob.bids[0].orderId;

      await program.methods
        .cancelOrder(orderId)
        .accountsPartial({
          user: admin.publicKey,
          market: m.marketPda,
          orderBook: m.orderBookPda,
          obUsdcVault: m.obUsdcVault,
          obYesVault: m.obYesVault,
          refundDestination: adminUsdcAta,
        })
        .rpc();

      const usdcAfter = await tokenAmount(adminUsdcAta);
      expect(usdcAfter).to.equal(usdcBefore); // fully refunded

      const ob2 = await program.account.orderBook.fetch(m.orderBookPda);
      expect(ob2.bidCount).to.equal(0);
    });

    it("cancel_order conserves bid escrow exactly across vault and refund destination", async () => {
      const m = await createMarketWithOB("OB8C", new anchor.BN(100_000_000));
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      await placeBid(m, admin.publicKey, adminUsdcAta, adminYes, 450_000, 3);

      const ob = await program.account.orderBook.fetch(m.orderBookPda);
      const orderId = ob.bids[0].orderId;
      const usdcBefore = await tokenAmount(adminUsdcAta);
      const obUsdcBefore = await tokenAmount(m.obUsdcVault);

      await program.methods
        .cancelOrder(orderId)
        .accountsPartial({
          user: admin.publicKey,
          market: m.marketPda,
          orderBook: m.orderBookPda,
          obUsdcVault: m.obUsdcVault,
          obYesVault: m.obYesVault,
          refundDestination: adminUsdcAta,
        })
        .rpc();

      const usdcAfter = await tokenAmount(adminUsdcAta);
      const obUsdcAfter = await tokenAmount(m.obUsdcVault);
      const refunded = 3 * 450_000;

      expectIncrease(usdcBefore, usdcAfter, refunded);
      expectDecrease(obUsdcBefore, obUsdcAfter, refunded);
      expect(obUsdcAfter).to.equal(0);
    });

    it("cancels a resting ask and refunds Yes tokens", async () => {
      const m = await createMarketWithOB("OB9", new anchor.BN(100_000_000));
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 3);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      const yesBefore = await tokenAmount(adminYes);

      await placeAsk(m, admin.publicKey, adminUsdcAta, adminYes, 700_000, 3);

      const ob = await program.account.orderBook.fetch(m.orderBookPda);
      const orderId = ob.asks[0].orderId;

      await program.methods
        .cancelOrder(orderId)
        .accountsPartial({
          user: admin.publicKey,
          market: m.marketPda,
          orderBook: m.orderBookPda,
          obUsdcVault: m.obUsdcVault,
          obYesVault: m.obYesVault,
          refundDestination: adminYes,
        })
        .rpc();

      const yesAfter = await tokenAmount(adminYes);
      expect(yesAfter).to.equal(yesBefore);

      const ob2 = await program.account.orderBook.fetch(m.orderBookPda);
      expect(ob2.askCount).to.equal(0);
    });

    // ── cancel_order - error paths ───────────────────────────────

    it("rejects cancel by non-owner on pending market (NotOrderOwner)", async () => {
      const m = await createMarketWithOB("OBX1", new anchor.BN(100_000_000));
      // Mint 1 pair so admin's Yes ATA exists
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      // Admin places a resting bid
      await placeBid(m, admin.publicKey, adminUsdcAta, adminYes, 500_000, 2);

      const ob = await program.account.orderBook.fetch(m.orderBookPda);
      const orderId = ob.bids[0].orderId;

      // userB tries to cancel admin's order on a pending (unsettled) market
      try {
        await program.methods
          .cancelOrder(orderId)
          .accountsPartial({
            user: userB.publicKey,
            market: m.marketPda,
            orderBook: m.orderBookPda,
            obUsdcVault: m.obUsdcVault,
            obYesVault: m.obYesVault,
            refundDestination: adminUsdcAta,
          })
          .signers([userB])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NotOrderOwner");
      }
    });

    it("rejects cancel with non-existent order_id (OrderNotFound)", async () => {
      const m = await createMarketWithOB("OBX2", new anchor.BN(100_000_000));
      // Mint 1 pair so admin's Yes ATA exists
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);

      try {
        await program.methods
          .cancelOrder(new anchor.BN(99999))
          .accountsPartial({
            user: admin.publicKey,
            market: m.marketPda,
            orderBook: m.orderBookPda,
            obUsdcVault: m.obUsdcVault,
            obYesVault: m.obYesVault,
            refundDestination: adminUsdcAta,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("OrderNotFound");
      }
    });

    // ── place_order - rejections ───────────────────────────────

    it("rejects price = 0", async () => {
      const m = await createMarketWithOB("OBB", new anchor.BN(100_000_000));
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      try {
        await placeBid(m, admin.publicKey, adminUsdcAta, adminYes, 0, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidPrice");
      }
    });

    it("rejects price = 1_000_000", async () => {
      const m = await createMarketWithOB("OBC", new anchor.BN(100_000_000));
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      try {
        await placeBid(m, admin.publicKey, adminUsdcAta, adminYes, 1_000_000, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidPrice");
      }
    });

    it("rejects quantity = 0", async () => {
      const m = await createMarketWithOB("OBD", new anchor.BN(100_000_000));
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      try {
        await placeBid(m, admin.publicKey, adminUsdcAta, adminYes, 500_000, 0);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidAmount");
      }
    });

    it("rejects place_order on settled market", async () => {
      const m = await createMarketWithOB("OBE", new anchor.BN(100_000_000));
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      await adminSettleMarket(m, new anchor.BN(110_000_000));

      try {
        await placeBid(m, admin.publicKey, adminUsdcAta, adminYes, 500_000, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketAlreadySettled");
      }
    });

    it("rejects place_order when paused", async () => {
      const m = await createMarketWithOB("OBF", new anchor.BN(100_000_000));
      await mintPairsFor(m, admin.publicKey, adminUsdcAta, 1);
      const adminYes = getAssociatedTokenAddressSync(m.yesMintPda, admin.publicKey);

      // Pause protocol
      await program.methods
        .pause()
        .accountsPartial({ admin: admin.publicKey })
        .rpc();

      try {
        await placeBid(m, admin.publicKey, adminUsdcAta, adminYes, 500_000, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Paused");
      } finally {
        // Unpause so other tests are not affected
        await program.methods
          .unpause()
          .accountsPartial({ admin: admin.publicKey })
          .rpc();
      }
    });
  });

  describe("trade path scenarios", () => {
    const connection = provider.connection;
    let userB: Keypair;
    let userBUsdc: PublicKey;
    let userC: Keypair;
    let userCUsdc: PublicKey;
    let atomicMarketIdx = 1500000000;

    function nextAtomicDate() {
      return new anchor.BN(atomicMarketIdx++);
    }

    before(async () => {
      const [fundedB, fundedC] = await Promise.all([
        createFundedUser(50_000_000),
        createFundedUser(50_000_000),
      ]);
      userB = fundedB.user;
      userBUsdc = fundedB.userUsdc;
      userC = fundedC.user;
      userCUsdc = fundedC.userUsdc;
    });

    it("buy yes: a crossing bid acquires Yes from a resting ask", async () => {
      const pdas = await createMarket("BYES", new anchor.BN(245_000_000), nextAtomicDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, admin.publicKey);
      const userBYes = getAssociatedTokenAddressSync(pdas.yesMintPda, userB.publicKey);

      await mintPairForAdmin(pdas, 1);

      const adminUsdcBefore = await tokenAmount(adminUsdcAta);
      const userBUsdcBefore = await tokenAmount(userBUsdc);

      await placeAsk({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes, 450_000, 1);
      await buyYes(
        { ...pdas, ...obPdas },
        userB.publicKey,
        userBUsdc,
        userBYes,
        500_000,
        1,
        { signers: [userB] }
      );
      await claimFills({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes);

      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const userBYesAfter = await tokenAmount(userBYes);
      const obAfter = await program.account.orderBook.fetch(obPdas.orderBookPda);

      expectIncrease(adminUsdcBefore, adminUsdcAfter, 450_000);
      expectDecrease(userBUsdcBefore, userBUsdcAfter, 450_000);
      expect(userBYesAfter).to.equal(1);
      expect(obAfter.bidCount).to.equal(0);
      expect(obAfter.askCount).to.equal(0);
    });

    it("sell yes: a crossing ask sells Yes into a resting bid", async () => {
      const pdas = await createMarket("SYES", new anchor.BN(246_000_000), nextAtomicDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const { userYes: userBYes } = await mintPairForUser(
        userB.publicKey,
        userBUsdc,
        pdas,
        1,
        [userB]
      );
      const adminYes = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pdas.yesMintPda,
        admin.publicKey
      );

      const adminYesBefore = await tokenAmount(adminYes);
      const userBUsdcBefore = await tokenAmount(userBUsdc);

      await placeBid({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes, 550_000, 1);
      await sellYes(
        { ...pdas, ...obPdas },
        userB.publicKey,
        userBUsdc,
        userBYes,
        500_000,
        1,
        { signers: [userB] }
      );
      await claimFills({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes);

      const adminYesAfter = await tokenAmount(adminYes);
      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const userBYesAfter = await tokenAmount(userBYes);
      const obAfter = await program.account.orderBook.fetch(obPdas.orderBookPda);

      expectIncrease(adminYesBefore, adminYesAfter, 1);
      expectIncrease(userBUsdcBefore, userBUsdcAfter, 550_000);
      expect(userBYesAfter).to.equal(0);
      expect(obAfter.bidCount).to.equal(0);
      expect(obAfter.askCount).to.equal(0);
    });

    it("buy no: mints a pair, sells Yes into resting bids, and leaves the user long No", async () => {
      const pdas = await createMarket("ABNO", new anchor.BN(250_000_000), nextAtomicDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pdas.yesMintPda,
        admin.publicKey
      );
      const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(
        userB.publicKey,
        pdas
      );

      const adminUsdcBefore = await tokenAmount(adminUsdcAta);
      const userBUsdcBefore = await tokenAmount(userBUsdc);

      await placeBid(
        { ...pdas, ...obPdas },
        admin.publicKey,
        adminUsdcAta,
        adminYes,
        650_000,
        1
      );

      await buyNo(
        { ...pdas, ...obPdas },
        userB.publicKey,
        userBUsdc,
        userBYes,
        userBNo,
        600_000,
        1,
        { signers: [userB] }
      );
      await claimFills({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes);

      const adminYesAfter = await tokenAmount(adminYes);
      const userBYesAfter = await tokenAmount(userBYes);
      const userBNoAfter = await tokenAmount(userBNo);
      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const vaultAfter = await tokenAmount(pdas.vaultPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      const orderBook = await program.account.orderBook.fetch(obPdas.orderBookPda);

      expect(adminYesAfter).to.equal(1);
      expect(userBYesAfter).to.equal(0);
      expect(userBNoAfter).to.equal(1);
      expectDecrease(adminUsdcBefore, adminUsdcAfter, 650_000);
      expectDecrease(userBUsdcBefore, userBUsdcAfter, 350_000);
      expect(vaultAfter).to.equal(1_000_000);
      expect(market.totalPairsMinted.toNumber()).to.equal(1);
      expect(orderBook.bidCount).to.equal(0);
      expect(orderBook.askCount).to.equal(0);
    });

    it("buy no: partially fills across multiple bids and leaves the residual bid on book", async () => {
      const pdas = await createMarket("ABNP", new anchor.BN(251_000_000), nextAtomicDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pdas.yesMintPda,
        admin.publicKey
      );
      const userCYes = await createAssociatedTokenAccount(
        connection,
        userC,
        pdas.yesMintPda,
        userC.publicKey
      );
      const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

      const adminUsdcBefore = await tokenAmount(adminUsdcAta);
      const userCUsdcBefore = await tokenAmount(userCUsdc);
      const userBUsdcBefore = await tokenAmount(userBUsdc);

      await placeBid({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes, 650_000, 1);
      await placeBid(
        { ...pdas, ...obPdas },
        userC.publicKey,
        userCUsdc,
        userCYes,
        640_000,
        2,
        { signers: [userC] }
      );

      await buyNo(
        { ...pdas, ...obPdas },
        userB.publicKey,
        userBUsdc,
        userBYes,
        userBNo,
        600_000,
        2,
        { signers: [userB] }
      );
      await claimFills({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes);
      await claimFills({ ...pdas, ...obPdas }, userC.publicKey, userCUsdc, userCYes);

      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      const userCUsdcAfter = await tokenAmount(userCUsdc);
      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const adminYesAfter = await tokenAmount(adminYes);
      const userCYesAfter = await tokenAmount(userCYes);
      const userBYesAfter = await tokenAmount(userBYes);
      const userBNoAfter = await tokenAmount(userBNo);
      const yesMint = await getMint(connection, pdas.yesMintPda);
      const noMint = await getMint(connection, pdas.noMintPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      const orderBook = await program.account.orderBook.fetch(obPdas.orderBookPda);

      expectDecrease(adminUsdcBefore, adminUsdcAfter, 650_000);
      expectDecrease(userCUsdcBefore, userCUsdcAfter, 640_000);
      expectDecrease(userBUsdcBefore, userBUsdcAfter, 710_000);
      expect(adminYesAfter).to.equal(1);
      expect(userCYesAfter).to.equal(1);
      expect(userBYesAfter).to.equal(0);
      expect(userBNoAfter).to.equal(2);
      expect(Number(yesMint.supply)).to.equal(2);
      expect(Number(noMint.supply)).to.equal(2);
      expect(market.totalPairsMinted.toNumber()).to.equal(2);
      expect(orderBook.bidCount).to.equal(1);
      expect(orderBook.askCount).to.equal(0);
      expect(orderBook.bids[0].owner.toBase58()).to.equal(userC.publicKey.toBase58());
      expect(orderBook.bids[0].price.toNumber()).to.equal(640_000);
      expect(orderBook.bids[0].quantity.toNumber()).to.equal(1);
    });

    it("sell no: buys Yes from resting asks, burns the pair, and returns USDC collateral", async () => {
      const pdas = await createMarket("ASNO", new anchor.BN(260_000_000), nextAtomicDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, admin.publicKey);
      const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(
        userB.publicKey,
        pdas
      );

      await mintPairForAdmin({ ...pdas, ...obPdas }, 2);
      await mintPairForUser(userB.publicKey, userBUsdc, pdas, 2, [userB]);

      await placeAsk(
        { ...pdas, ...obPdas },
        admin.publicKey,
        adminUsdcAta,
        adminYes,
        400_000,
        2
      );

      const adminUsdcBefore = await tokenAmount(adminUsdcAta);
      const userBUsdcBefore = await tokenAmount(userBUsdc);

      await sellNo(
        { ...pdas, ...obPdas },
        userB.publicKey,
        userBUsdc,
        userBYes,
        userBNo,
        400_000,
        2,
        { signers: [userB] }
      );
      await claimFills({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes);

      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const userBYesAfter = await tokenAmount(userBYes);
      const userBNoAfter = await tokenAmount(userBNo);
      const vaultAfter = await tokenAmount(pdas.vaultPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      const orderBook = await program.account.orderBook.fetch(obPdas.orderBookPda);

      expectIncrease(adminUsdcBefore, adminUsdcAfter, 800_000);
      expectIncrease(userBUsdcBefore, userBUsdcAfter, 1_200_000);
      expect(userBYesAfter).to.equal(2);
      expect(userBNoAfter).to.equal(0);
      expect(vaultAfter).to.equal(2_000_000);
      expect(market.totalPairsMinted.toNumber()).to.equal(2);
      expect(orderBook.bidCount).to.equal(0);
      expect(orderBook.askCount).to.equal(0);
    });

    it("sell no: partially fills across multiple asks and leaves the residual ask on book", async () => {
      const pdas = await createMarket("ASNP", new anchor.BN(261_000_000), nextAtomicDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, admin.publicKey);
      const { userYes: userCYes } = await mintPairForUser(
        userC.publicKey,
        userCUsdc,
        pdas,
        2,
        [userC]
      );
      const { userYes: userBYes, userNo: userBNo } = await mintPairForUser(
        userB.publicKey,
        userBUsdc,
        pdas,
        2,
        [userB]
      );

      await mintPairForAdmin({ ...pdas, ...obPdas }, 1);

      await placeAsk({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes, 300_000, 1);
      await placeAsk(
        { ...pdas, ...obPdas },
        userC.publicKey,
        userCUsdc,
        userCYes,
        350_000,
        2,
        { signers: [userC] }
      );

      const adminUsdcBefore = await tokenAmount(adminUsdcAta);
      const userCUsdcBefore = await tokenAmount(userCUsdc);
      const userBUsdcBefore = await tokenAmount(userBUsdc);

      await sellNo(
        { ...pdas, ...obPdas },
        userB.publicKey,
        userBUsdc,
        userBYes,
        userBNo,
        400_000,
        2,
        { signers: [userB] }
      );
      await claimFills({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes);
      await claimFills({ ...pdas, ...obPdas }, userC.publicKey, userCUsdc, userCYes);

      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      const userCUsdcAfter = await tokenAmount(userCUsdc);
      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const userBYesAfter = await tokenAmount(userBYes);
      const userBNoAfter = await tokenAmount(userBNo);
      const vaultAfter = await tokenAmount(pdas.vaultPda);
      const yesMint = await getMint(connection, pdas.yesMintPda);
      const noMint = await getMint(connection, pdas.noMintPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      const orderBook = await program.account.orderBook.fetch(obPdas.orderBookPda);

      expectIncrease(adminUsdcBefore, adminUsdcAfter, 300_000);
      expectIncrease(userCUsdcBefore, userCUsdcAfter, 350_000);
      expectIncrease(userBUsdcBefore, userBUsdcAfter, 1_350_000);
      expect(userBYesAfter).to.equal(2);
      expect(userBNoAfter).to.equal(0);
      expect(vaultAfter).to.equal(3_000_000);
      expect(Number(yesMint.supply)).to.equal(3);
      expect(Number(noMint.supply)).to.equal(3);
      expect(market.totalPairsMinted.toNumber()).to.equal(3);
      expect(orderBook.bidCount).to.equal(0);
      expect(orderBook.askCount).to.equal(1);
      expect(orderBook.asks[0].owner.toBase58()).to.equal(userC.publicKey.toBase58());
      expect(orderBook.asks[0].price.toNumber()).to.equal(350_000);
      expect(orderBook.asks[0].quantity.toNumber()).to.equal(1);
    });

    it("buy no: incomplete atomic fill leaves user balances and vaults unchanged", async () => {
      const pdas = await createMarket("ABNF", new anchor.BN(252_000_000), nextAtomicDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pdas.yesMintPda,
        admin.publicKey
      );
      const userBYes = await createAssociatedTokenAccount(
        connection,
        userB,
        pdas.yesMintPda,
        userB.publicKey
      );
      const userBNo = await createAssociatedTokenAccount(
        connection,
        userB,
        pdas.noMintPda,
        userB.publicKey
      );

      await placeBid({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes, 650_000, 1);

      const userBUsdcBefore = await tokenAmount(userBUsdc);
      const userBYesBefore = await tokenAmount(userBYes);
      const userBNoBefore = await tokenAmount(userBNo);
      const marketVaultBefore = await tokenAmount(pdas.vaultPda);
      const obUsdcBefore = await tokenAmount(obPdas.obUsdcVault);
      const obYesBefore = await tokenAmount(obPdas.obYesVault);
      const orderBookBefore = await program.account.orderBook.fetch(obPdas.orderBookPda);

      try {
        await buyNo(
          { ...pdas, ...obPdas },
          userB.publicKey,
          userBUsdc,
          userBYes,
          userBNo,
          600_000,
          2,
          { signers: [userB] }
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AtomicTradeIncomplete");
      }

      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const userBYesAfter = await tokenAmount(userBYes);
      const userBNoAfter = await tokenAmount(userBNo);
      const marketVaultAfter = await tokenAmount(pdas.vaultPda);
      const obUsdcAfter = await tokenAmount(obPdas.obUsdcVault);
      const obYesAfter = await tokenAmount(obPdas.obYesVault);
      const orderBookAfter = await program.account.orderBook.fetch(obPdas.orderBookPda);

      expect(userBUsdcAfter).to.equal(userBUsdcBefore);
      expect(userBYesAfter).to.equal(userBYesBefore);
      expect(userBNoAfter).to.equal(userBNoBefore);
      expect(marketVaultAfter).to.equal(marketVaultBefore);
      expect(obUsdcAfter).to.equal(obUsdcBefore);
      expect(obYesAfter).to.equal(obYesBefore);
      expect(orderBookAfter.bidCount).to.equal(orderBookBefore.bidCount);
      expect(orderBookAfter.bids[0].quantity.toNumber()).to.equal(
        orderBookBefore.bids[0].quantity.toNumber()
      );
    });

    it("sell no: incomplete atomic fill leaves user balances and vaults unchanged", async () => {
      const pdas = await createMarket("ASNF", new anchor.BN(262_000_000), nextAtomicDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, admin.publicKey);
      const { userYes: userBYes, userNo: userBNo } = await mintPairForUser(
        userB.publicKey,
        userBUsdc,
        pdas,
        2,
        [userB]
      );

      await mintPairForAdmin({ ...pdas, ...obPdas }, 1);
      await placeAsk({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes, 400_000, 1);

      const userBUsdcBefore = await tokenAmount(userBUsdc);
      const userBYesBefore = await tokenAmount(userBYes);
      const userBNoBefore = await tokenAmount(userBNo);
      const marketVaultBefore = await tokenAmount(pdas.vaultPda);
      const obUsdcBefore = await tokenAmount(obPdas.obUsdcVault);
      const obYesBefore = await tokenAmount(obPdas.obYesVault);
      const orderBookBefore = await program.account.orderBook.fetch(obPdas.orderBookPda);

      try {
        await sellNo(
          { ...pdas, ...obPdas },
          userB.publicKey,
          userBUsdc,
          userBYes,
          userBNo,
          400_000,
          2,
          { signers: [userB] }
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AtomicTradeIncomplete");
      }

      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const userBYesAfter = await tokenAmount(userBYes);
      const userBNoAfter = await tokenAmount(userBNo);
      const marketVaultAfter = await tokenAmount(pdas.vaultPda);
      const obUsdcAfter = await tokenAmount(obPdas.obUsdcVault);
      const obYesAfter = await tokenAmount(obPdas.obYesVault);
      const orderBookAfter = await program.account.orderBook.fetch(obPdas.orderBookPda);

      expect(userBUsdcAfter).to.equal(userBUsdcBefore);
      expect(userBYesAfter).to.equal(userBYesBefore);
      expect(userBNoAfter).to.equal(userBNoBefore);
      expect(marketVaultAfter).to.equal(marketVaultBefore);
      expect(obUsdcAfter).to.equal(obUsdcBefore);
      expect(obYesAfter).to.equal(obYesBefore);
      expect(orderBookAfter.askCount).to.equal(orderBookBefore.askCount);
      expect(orderBookAfter.asks[0].quantity.toNumber()).to.equal(
        orderBookBefore.asks[0].quantity.toNumber()
      );
    });
  });

  describe("frozen market behavior", () => {
    const connection = provider.connection;
    let userB: Keypair;
    let userBUsdc: PublicKey;
    let freezeMarketIdx = 1550000000;

    function nextFreezeDate() {
      return new anchor.BN(freezeMarketIdx++);
    }

    before(async () => {
      const funded = await createFundedUser(20_000_000);
      userB = funded.user;
      userBUsdc = funded.userUsdc;
    });

    it("rejects mint_pair after market freeze", async () => {
      const pdas = await createMarket("FRZM", new anchor.BN(270_000_000), nextFreezeDate());
      await freezeMarket(pdas);
      const { userYes, userNo } = userTokenAccounts(pdas);

      try {
        await methods
          .mintPair(new anchor.BN(1))
          .accountsPartial({
            user: admin.publicKey,
            market: pdas.marketPda,
            userUsdc: adminUsdcAta,
            vault: pdas.vaultPda,
            yesMint: pdas.yesMintPda,
            noMint: pdas.noMintPda,
            userYes,
            userNo,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketFrozen");
      }
    });

    it("rejects place_order after market freeze", async () => {
      const pdas = await createMarket("FRZO", new anchor.BN(271_000_000), nextFreezeDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      await mintPairForAdmin(pdas, 1);
      const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, admin.publicKey);

      await freezeMarket(pdas);

      try {
        await placeAsk(
          { ...pdas, ...obPdas },
          admin.publicKey,
          adminUsdcAta,
          adminYes,
          500_000,
          1
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketFrozen");
      }
    });

    it("rejects composed buy-no flow after market freeze while settlement still succeeds", async () => {
      const pdas = await createMarket("FRZB", new anchor.BN(272_000_000), nextFreezeDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pdas.yesMintPda,
        admin.publicKey
      );
      const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

      await placeBid({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes, 650_000, 1);
      const obBefore = await program.account.orderBook.fetch(obPdas.orderBookPda);
      const bidOrderId = obBefore.bids[0].orderId;

      await freezeMarket(pdas);

      try {
        await buyNo(
          { ...pdas, ...obPdas },
          userB.publicKey,
          userBUsdc,
          userBYes,
          userBNo,
          600_000,
          1,
          { signers: [userB] }
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketFrozen");
      }

      await unwindOrderForSettlement(
        { ...pdas, ...obPdas },
        bidOrderId,
        adminUsdcAta,
        adminYes
      );
      await settleWithOrderBookProof({ ...pdas, ...obPdas }, new anchor.BN(300_000_000));

      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(market.outcome).to.deep.equal({ yesWins: {} });
    });

    it("rejects buy_yes after market freeze", async () => {
      const pdas = await createMarket("FRZY", new anchor.BN(273_000_000), nextFreezeDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, admin.publicKey);
      const userBYes = getAssociatedTokenAddressSync(pdas.yesMintPda, userB.publicKey);

      await mintPairForAdmin(pdas, 1);
      await placeAsk({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes, 500_000, 1);
      await freezeMarket(pdas);

      try {
        await buyYes(
          { ...pdas, ...obPdas },
          userB.publicKey,
          userBUsdc,
          userBYes,
          500_000,
          1,
          { signers: [userB] }
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketFrozen");
      }
    });

    it("rejects composed sell-no flow after market settles", async () => {
      const closedAt = await getCurrentUnixTimestamp();
      const marketDate = new anchor.BN(closedAt - 3_700);
      const pdas = await createMarket(
        "STNO",
        new anchor.BN(274_000_000),
        marketDate,
        new anchor.BN(closedAt - 3_600)
      );
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const { userYes: userBYes, userNo: userBNo } = await mintPairForUser(
        userB.publicKey,
        userBUsdc,
        pdas,
        1,
        [userB]
      );

      await adminSettleMarket(pdas, new anchor.BN(300_000_000));

      try {
        await sellNo(
          { ...pdas, ...obPdas },
          userB.publicKey,
          userBUsdc,
          userBYes,
          userBNo,
          400_000,
          1,
          { signers: [userB] }
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketAlreadySettled");
      }
    });

    it("rejects buy_yes after market settles", async () => {
      const pdas = await createMarket("STBY", new anchor.BN(275_000_000), nextFreezeDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const userBYes = getAssociatedTokenAddressSync(pdas.yesMintPda, userB.publicKey);

      await adminSettleMarket(pdas, new anchor.BN(300_000_000));

      try {
        await buyYes(
          { ...pdas, ...obPdas },
          userB.publicKey,
          userBUsdc,
          userBYes,
          500_000,
          1,
          { signers: [userB] }
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketAlreadySettled");
      }
    });
  });

  describe("multi-user settlement", () => {
    const connection = provider.connection;
    let userB: Keypair;
    let userBUsdc: PublicKey;
    let userC: Keypair;
    let userCUsdc: PublicKey;
    let settlementIdx = 1560000000;

    function nextSettlementDate() {
      return new anchor.BN(settlementIdx++);
    }

    before(async () => {
      const [fundedB, fundedC] = await Promise.all([
        createFundedUser(20_000_000),
        createFundedUser(20_000_000),
      ]);
      userB = fundedB.user;
      userBUsdc = fundedB.userUsdc;
      userC = fundedC.user;
      userCUsdc = fundedC.userUsdc;
    });

    it("pays only the winning side across two users and drains the vault after all claims", async () => {
      const pdas = await createMarket("MSET", new anchor.BN(280_000_000), nextSettlementDate());
      const { userYes: adminYes, userNo: adminNo } = await mintPairForAdmin(pdas, 2);
      const { userYes: userBYes, userNo: userBNo } = await mintPairForUser(
        userB.publicKey,
        userBUsdc,
        pdas,
        3,
        [userB]
      );

      const adminUsdcBefore = Number((await getAccount(connection, adminUsdcAta)).amount);
      const userBUsdcBefore = Number((await getAccount(connection, userBUsdc)).amount);

      await adminSettleMarket(pdas, new anchor.BN(250_000_000));

      await redeemForUser(pdas, admin.publicKey, adminUsdcAta, pdas.noMintPda, adminNo, 2);
      await redeemForUser(pdas, userB.publicKey, userBUsdc, pdas.noMintPda, userBNo, 3, [userB]);
      await redeemForUser(pdas, admin.publicKey, adminUsdcAta, pdas.yesMintPda, adminYes, 2);
      await redeemForUser(pdas, userB.publicKey, userBUsdc, pdas.yesMintPda, userBYes, 3, [userB]);

      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const vaultAfter = await tokenAmount(pdas.vaultPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      const adminYesAfter = await tokenAmount(adminYes);
      const adminNoAfter = await tokenAmount(adminNo);
      const userBYesAfter = await tokenAmount(userBYes);
      const userBNoAfter = await tokenAmount(userBNo);

      expectIncrease(adminUsdcBefore, adminUsdcAfter, 2_000_000);
      expectIncrease(userBUsdcBefore, userBUsdcAfter, 3_000_000);
      expect(vaultAfter).to.equal(0);
      expect(market.totalPairsMinted.toNumber()).to.equal(0);
      expect(adminYesAfter).to.equal(0);
      expect(adminNoAfter).to.equal(0);
      expect(userBYesAfter).to.equal(0);
      expect(userBNoAfter).to.equal(0);
    });

    it("drains the vault after redeeming winners and losers held across opposite-side wallets", async () => {
      const pdas = await createMarket("MSPL", new anchor.BN(281_000_000), nextSettlementDate());
      const { userYes: adminYes, userNo: adminNo } = await mintPairForAdmin(pdas, 5);
      const userBYes = await createAssociatedTokenAccount(
        connection,
        userB,
        pdas.yesMintPda,
        userB.publicKey
      );
      const userCNo = await createAssociatedTokenAccount(
        connection,
        userC,
        pdas.noMintPda,
        userC.publicKey
      );

      await transferTokens(adminYes, userBYes, admin.publicKey, 2);
      await transferTokens(adminNo, userCNo, admin.publicKey, 3);

      const adminUsdcBefore = await tokenAmount(adminUsdcAta);
      const userBUsdcBefore = await tokenAmount(userBUsdc);
      const userCUsdcBefore = await tokenAmount(userCUsdc);

      await adminSettleMarket(pdas, new anchor.BN(300_000_000));

      await redeemForUser(pdas, admin.publicKey, adminUsdcAta, pdas.yesMintPda, adminYes, 3);
      await redeemForUser(pdas, userB.publicKey, userBUsdc, pdas.yesMintPda, userBYes, 2, [userB]);
      await redeemForUser(pdas, admin.publicKey, adminUsdcAta, pdas.noMintPda, adminNo, 2);
      await redeemForUser(pdas, userC.publicKey, userCUsdc, pdas.noMintPda, userCNo, 3, [userC]);

      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      const userBUsdcAfter = await tokenAmount(userBUsdc);
      const userCUsdcAfter = await tokenAmount(userCUsdc);
      const vaultAfter = await tokenAmount(pdas.vaultPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      const adminYesAfter = await tokenAmount(adminYes);
      const adminNoAfter = await tokenAmount(adminNo);
      const userBYesAfter = await tokenAmount(userBYes);
      const userCNoAfter = await tokenAmount(userCNo);

      expectIncrease(adminUsdcBefore, adminUsdcAfter, 3_000_000);
      expectIncrease(userBUsdcBefore, userBUsdcAfter, 2_000_000);
      expect(userCUsdcAfter).to.equal(userCUsdcBefore);
      expect(vaultAfter).to.equal(0);
      expect(market.totalPairsMinted.toNumber()).to.equal(0);
      expect(adminYesAfter).to.equal(0);
      expect(adminNoAfter).to.equal(0);
      expect(userBYesAfter).to.equal(0);
      expect(userCNoAfter).to.equal(0);
    });
  });

  describe("settlement unwind flow", () => {
    const connection = provider.connection;
    let userB: Keypair;
    let userBUsdc: PublicKey;
    let unwindIdx = uniqueTestSeedBase + 10_000;

    function nextUnwindDate() {
      return new anchor.BN(unwindIdx++);
    }

    before(async () => {
      const funded = await createFundedUser(20_000_000);
      userB = funded.user;
      userBUsdc = funded.userUsdc;
    });

    it("auto-credits resting orders on settlement", async () => {
      const pdas = await createMarket("UWBL", new anchor.BN(290_000_000), nextUnwindDate());
      const market = pdas;
      const adminYes = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pdas.yesMintPda,
        admin.publicKey
      );

      await placeBid(market, admin.publicKey, adminUsdcAta, adminYes, 500_000, 1);

      await freezeMarket(market);

      await methods
        .adminSettle(new anchor.BN(300_000_000))
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          market: pdas.marketPda,
        })
        .remainingAccounts(settlementProofAccounts(market))
        .rpc();

      const settled = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(settled.outcome).to.not.deep.equal({ none: {} });
    });

    it("allows permissionless unwind during freeze while refunding the order owner", async () => {
      const pdas = await createMarket("UWPM", new anchor.BN(290_500_000), nextUnwindDate());
      const market = pdas;
      const { userYes: userBYes } = await mintPairForUser(
        userB.publicKey,
        userBUsdc,
        pdas,
        2,
        [userB]
      );

      await placeAsk(
        market,
        userB.publicKey,
        userBUsdc,
        userBYes,
        610_000,
        2,
        { signers: [userB] }
      );

      const yesBeforeFreeze = await tokenAmount(userBYes);
      const obBefore = await program.account.orderBook.fetch(market.orderBookPda);
      const askOrderId = obBefore.asks[0].orderId;

      expect(yesBeforeFreeze).to.equal(0);

      await freezeMarket(market);

      // Admin is not the order owner here. Settlement prep should still be able to
      // permissionlessly unwind the frozen order as long as refunds go to the owner.
      await unwindOrderForSettlement(
        market,
        askOrderId,
        userBUsdc,
        userBYes
      );

      const yesAfterUnwind = await tokenAmount(userBYes);
      const obYesEscrow = await tokenAmount(market.obYesVault);
      const obAfter = await program.account.orderBook.fetch(market.orderBookPda);

      expect(yesAfterUnwind).to.equal(2);
      expect(obYesEscrow).to.equal(0);
      expect(obAfter.askCount).to.equal(0);

      await settleWithOrderBookProof(market, new anchor.BN(300_000_000));

      const settled = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(settled.outcome).to.deep.equal({ yesWins: {} });
    });

    it("unwind_order conserves ask escrow exactly across vault and refund destination", async () => {
      const pdas = await createMarket("UWCV", new anchor.BN(290_750_000), nextUnwindDate());
      const market = pdas;
      const { userYes: userBYes } = await mintPairForUser(
        userB.publicKey,
        userBUsdc,
        pdas,
        2,
        [userB]
      );

      await placeAsk(
        market,
        userB.publicKey,
        userBUsdc,
        userBYes,
        620_000,
        2,
        { signers: [userB] }
      );

      const obBefore = await program.account.orderBook.fetch(market.orderBookPda);
      const askOrderId = obBefore.asks[0].orderId;
      const userYesBefore = await tokenAmount(userBYes);
      const obYesBefore = await tokenAmount(market.obYesVault);

      await freezeMarket(market);
      await unwindOrderForSettlement(market, askOrderId, userBUsdc, userBYes);

      const userYesAfter = await tokenAmount(userBYes);
      const obYesAfter = await tokenAmount(market.obYesVault);

      expectIncrease(userYesBefore, userYesAfter, 2);
      expectDecrease(obYesBefore, obYesAfter, 2);
      expect(obYesAfter).to.equal(0);
    });

    it("unwinds bid and ask escrow during freeze, then allows settlement", async () => {
      const pdas = await createMarket("UWOK", new anchor.BN(291_000_000), nextUnwindDate());
      const market = pdas;
      const adminYes = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pdas.yesMintPda,
        admin.publicKey
      );
      const { userYes: userBYes } = await mintPairForUser(
        userB.publicKey,
        userBUsdc,
        pdas,
        1,
        [userB]
      );

      const adminUsdcBefore = await tokenAmount(adminUsdcAta);
      const userBYesBefore = await tokenAmount(userBYes);

      await placeBid(market, admin.publicKey, adminUsdcAta, adminYes, 500_000, 2);
      await placeAsk(
        market,
        userB.publicKey,
        userBUsdc,
        userBYes,
        600_000,
        1,
        { signers: [userB] }
      );

      const obBefore = await program.account.orderBook.fetch(market.orderBookPda);
      const bidOrderId = obBefore.bids[0].orderId;
      const askOrderId = obBefore.asks[0].orderId;

      await freezeMarket(market);

      await unwindOrderForSettlement(
        market,
        bidOrderId,
        adminUsdcAta,
        adminYes
      );
      await unwindOrderForSettlement(
        market,
        askOrderId,
        userBUsdc,
        userBYes,
        userB
      );

      const adminUsdcAfterUnwind = await tokenAmount(adminUsdcAta);
      const userBYesAfterUnwind = await tokenAmount(userBYes);
      const obUsdcEscrow = await tokenAmount(market.obUsdcVault);
      const obYesEscrow = await tokenAmount(market.obYesVault);
      const obAfter = await program.account.orderBook.fetch(market.orderBookPda);

      expectIncrease(adminUsdcBefore, adminUsdcAfterUnwind, 0);
      expect(userBYesAfterUnwind).to.equal(userBYesBefore);
      expect(obUsdcEscrow).to.equal(0);
      expect(obYesEscrow).to.equal(0);
      expect(obAfter.bidCount).to.equal(0);
      expect(obAfter.askCount).to.equal(0);

      await settleWithOrderBookProof(market, new anchor.BN(300_000_000));

      const settled = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(settled.outcome).to.deep.equal({ yesWins: {} });
    });

    it("roundtrips create -> freeze -> settle-with-proof -> redeem against config-backed oracle policy", async () => {
      const config = await program.account.globalConfig.fetch(configPda);
      const metaPolicy = config.oraclePolicies.find((policy: any) => policy.ticker === "META");
      expect(metaPolicy).to.not.equal(undefined);

      const pdas = await createMarket("META", new anchor.BN(292_000_000), nextUnwindDate());
      const market = pdas;
      const { userYes } = await mintPairForAdmin(pdas, 2);

      const adminUsdcBefore = await tokenAmount(adminUsdcAta);

      await freezeMarket(market);
      await settleWithOrderBookProof(market, new anchor.BN(300_000_000));
      await redeemForUser(pdas, admin.publicKey, adminUsdcAta, pdas.yesMintPda, userYes, 2);

      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      const vaultAfter = await tokenAmount(pdas.vaultPda);
      const settled = await program.account.strikeMarket.fetch(pdas.marketPda);
      const yesBalanceAfter = await tokenAmount(userYes);

      expectIncrease(adminUsdcBefore, adminUsdcAfter, 2_000_000);
      expect(vaultAfter).to.equal(0);
      expect(yesBalanceAfter).to.equal(0);
      expect(settled.outcome).to.deep.equal({ yesWins: {} });
      expect(settled.totalPairsMinted.toNumber()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  PAUSE / UNPAUSE TESTS
  // ═══════════════════════════════════════════════════════════════

  describe("pause / unpause", () => {
    const connection = provider.connection;
    let nonAdmin: Keypair;

    // Unique market for pause mint tests
    const pTicker = "PAUS";
    const pStrike = new anchor.BN(111_000_000);
    const pDate = new anchor.BN(1600000001);
    let pMarket: ReturnType<typeof deriveMarketPdas>;

    before(async () => {
      nonAdmin = Keypair.generate();
      const sig = await connection.requestAirdrop(
        nonAdmin.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);

      // Create market for mint-during-pause tests
      pMarket = await createMarket(pTicker, pStrike, pDate);
    });

    it("pause sets config.paused = true", async () => {
      await pauseProtocol();

      const config = await program.account.globalConfig.fetch(configPda);
      expect(config.paused).to.equal(true);
    });

    it("mint rejected during pause (Paused error)", async () => {
      try {
        await mintPairForAdmin(pMarket, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Paused");
      }
    });

    it("admin settlement still succeeds while paused", async () => {
      const pausedMarket = await createMarket(
        "PAST",
        new anchor.BN(112_000_000),
        new anchor.BN(1600000002)
      );

      await freezeMarket(pausedMarket);
      await settleWithOrderBookProof(pausedMarket, new anchor.BN(113_000_000));

      const market = await program.account.strikeMarket.fetch(pausedMarket.marketPda);
      expect(market.outcome).to.deep.equal({ yesWins: {} });
    });

    it("redeem still succeeds while paused", async () => {
      const pausedRedeemMarket = await createMarket(
        "PRED",
        new anchor.BN(113_000_000),
        new anchor.BN(1600000003)
      );
      const { userYes } = await mintPairForAdmin(pausedRedeemMarket, 1);

      await adminSettleMarket(pausedRedeemMarket, new anchor.BN(114_000_000));

      const adminUsdcBefore = await tokenAmount(adminUsdcAta);
      await pauseProtocol();

      await redeemForUser(
        pausedRedeemMarket,
        admin.publicKey,
        adminUsdcAta,
        pausedRedeemMarket.yesMintPda,
        userYes,
        1
      );

      const adminUsdcAfter = await tokenAmount(adminUsdcAta);
      expectIncrease(adminUsdcBefore, adminUsdcAfter, 1_000_000);
    });

    it("unpause sets config.paused = false", async () => {
      await unpauseProtocol();

      const config = await program.account.globalConfig.fetch(configPda);
      expect(config.paused).to.equal(false);
    });

    it("mint succeeds after unpause", async () => {
      await mintPairForAdmin(pMarket, 1);

      const vaultAccount = await getAccount(connection, pMarket.vaultPda);
      expect(Number(vaultAccount.amount)).to.equal(1_000_000);
    });

    it("non-admin cannot pause (Unauthorized)", async () => {
      try {
        await pauseProtocol(nonAdmin.publicKey, [nonAdmin]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor constraint error - has_one = admin
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|2012/);
      }
    });

    it("non-admin cannot unpause (Unauthorized)", async () => {
      try {
        await unpauseProtocol(nonAdmin.publicKey, [nonAdmin]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.match(/Unauthorized|ConstraintHasOne|2012/);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  VAULT INVARIANT TESTS
  // ═══════════════════════════════════════════════════════════════

  describe("vault invariants", () => {
    const connection = provider.connection;

    it("after multiple mints: vault == totalPairsMinted * 1_000_000", async () => {
      const pdas = await createMarket("IVLT", new anchor.BN(222_000_000), new anchor.BN(1600000010));

      for (let i = 0; i < 7; i++) {
        await mintPairForAdmin(pdas, 1);
      }

      const vault = await getAccount(connection, pdas.vaultPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(Number(vault.amount)).to.equal(market.totalPairsMinted.toNumber() * 1_000_000);
      expect(market.totalPairsMinted.toNumber()).to.equal(7);
    });

    it("after mint then burn: vault == totalPairsMinted * 1_000_000", async () => {
      const pdas = await createMarket("IVBU", new anchor.BN(223_000_000), new anchor.BN(1600000011));

      // Mint 5
      for (let i = 0; i < 5; i++) {
        await mintPairForAdmin(pdas, 1);
      }

      // Burn 2
      await burnPairForUser(admin.publicKey, adminUsdcAta, pdas, 2);

      const vault = await getAccount(connection, pdas.vaultPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(market.totalPairsMinted.toNumber()).to.equal(3);
      expect(Number(vault.amount)).to.equal(3 * 1_000_000);
    });

    it("after mint, settle, redeem winner: vault == (total - redeemed) * 1_000_000", async () => {
      const pdas = await createMarket("IVRD", new anchor.BN(224_000_000), new anchor.BN(1600000012));
      const { userYes } = userTokenAccounts(pdas);

      // Mint 6
      for (let i = 0; i < 6; i++) {
        await mintPairForAdmin(pdas, 1);
      }

      // Settle -> YesWins
      await adminSettleMarket(pdas, new anchor.BN(224_000_000));

      // Redeem 4 Yes (winner)
      await redeemForUser(
        pdas,
        admin.publicKey,
        adminUsdcAta,
        pdas.yesMintPda,
        userYes,
        4
      );

      const vault = await getAccount(connection, pdas.vaultPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      // 6 minted - 4 redeemed = 2 remaining
      expect(market.totalPairsMinted.toNumber()).to.equal(2);
      expect(Number(vault.amount)).to.equal(2 * 1_000_000);
    });

    it("full lifecycle (mint 10, burn 3, settle, redeem 7 winners): vault empty", async () => {
      const pdas = await createMarket("IVFL", new anchor.BN(225_000_000), new anchor.BN(1600000013));
      const { userYes, userNo } = userTokenAccounts(pdas);

      // Mint 10
      for (let i = 0; i < 10; i++) {
        await mintPairForAdmin(pdas, 1);
      }

      // Burn 3
      await burnPairForUser(admin.publicKey, adminUsdcAta, pdas, 3);

      // Settle -> NoWins (price below strike)
      await adminSettleMarket(pdas, new anchor.BN(200_000_000));

      // Redeem 7 No tokens (winner)
      await redeemForUser(
        pdas,
        admin.publicKey,
        adminUsdcAta,
        pdas.noMintPda,
        userNo,
        7
      );

      // Redeem 7 Yes tokens (loser - 0 USDC)
      await redeemForUser(
        pdas,
        admin.publicKey,
        adminUsdcAta,
        pdas.yesMintPda,
        userYes,
        7
      );

      const vault = await getAccount(connection, pdas.vaultPda);
      expect(Number(vault.amount)).to.equal(0);

      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(market.totalPairsMinted.toNumber()).to.equal(0);
    });

    it("repeated partial winner claims decrease vault, supply, and open interest in lockstep", async () => {
      const pdas = await createMarket("IVPM", new anchor.BN(226_000_000), new anchor.BN(1600000014));
      const { userYes, userNo } = userTokenAccounts(pdas);

      await mintPairForAdmin(pdas, 5);
      await adminSettleMarket(pdas, new anchor.BN(226_000_000));

      const winnerRedeems = [1, 2, 2];
      let redeemedWinners = 0;

      for (const amount of winnerRedeems) {
        await redeemForUser(
          pdas,
          admin.publicKey,
          adminUsdcAta,
          pdas.yesMintPda,
          userYes,
          amount
        );
        redeemedWinners += amount;

        const vault = await getAccount(connection, pdas.vaultPda);
        const yesMint = await getMint(connection, pdas.yesMintPda);
        const noMint = await getMint(connection, pdas.noMintPda);
        const market = await program.account.strikeMarket.fetch(pdas.marketPda);
        const remainingClaims = 5 - redeemedWinners;

        expect(Number(vault.amount)).to.equal(remainingClaims * 1_000_000);
        expect(Number(yesMint.supply)).to.equal(remainingClaims);
        expect(Number(noMint.supply)).to.equal(5);
        expect(market.totalPairsMinted.toNumber()).to.equal(remainingClaims);
      }

      await redeemForUser(
        pdas,
        admin.publicKey,
        adminUsdcAta,
        pdas.noMintPda,
        userNo,
        5
      );

      const finalVault = await getAccount(connection, pdas.vaultPda);
      const finalYesMint = await getMint(connection, pdas.yesMintPda);
      const finalNoMint = await getMint(connection, pdas.noMintPda);
      const finalMarket = await program.account.strikeMarket.fetch(pdas.marketPda);

      expect(Number(finalVault.amount)).to.equal(0);
      expect(Number(finalYesMint.supply)).to.equal(0);
      expect(Number(finalNoMint.supply)).to.equal(0);
      expect(finalMarket.totalPairsMinted.toNumber()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  TOKEN SUPPLY INVARIANT TESTS
  // ═══════════════════════════════════════════════════════════════

  describe("token supply invariants", () => {
    const connection = provider.connection;
    let userB: Keypair;
    let userBUsdc: PublicKey;
    let supplyMarketIdx = 1600000022;

    function nextSupplyDate() {
      return new anchor.BN(supplyMarketIdx++);
    }

    before(async () => {
      const funded = await createFundedUser(20_000_000);
      userB = funded.user;
      userBUsdc = funded.userUsdc;
    });

    it("after mint: yes_supply == no_supply == totalPairsMinted", async () => {
      const pdas = await createMarket("ISUP", new anchor.BN(230_000_000), new anchor.BN(1600000020));

      for (let i = 0; i < 4; i++) {
        await mintPairForAdmin(pdas, 1);
      }

      const yesMint = await getMint(connection, pdas.yesMintPda);
      const noMint = await getMint(connection, pdas.noMintPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);

      expect(Number(yesMint.supply)).to.equal(4);
      expect(Number(noMint.supply)).to.equal(4);
      expect(Number(yesMint.supply)).to.equal(Number(noMint.supply));
      expect(Number(yesMint.supply)).to.equal(market.totalPairsMinted.toNumber());
    });

    it("after burn: yes_supply == no_supply (still equal)", async () => {
      const pdas = await createMarket("ISUB", new anchor.BN(231_000_000), new anchor.BN(1600000021));

      // Mint 6
      for (let i = 0; i < 6; i++) {
        await mintPairForAdmin(pdas, 1);
      }

      // Burn 2
      await burnPairForUser(admin.publicKey, adminUsdcAta, pdas, 2);

      const yesMint = await getMint(connection, pdas.yesMintPda);
      const noMint = await getMint(connection, pdas.noMintPda);

      expect(Number(yesMint.supply)).to.equal(4);
      expect(Number(noMint.supply)).to.equal(4);
      expect(Number(yesMint.supply)).to.equal(Number(noMint.supply));
    });

    it("after atomic buy-no composition: unsettled yes_supply == no_supply == totalPairsMinted", async () => {
      const pdas = await createMarket("ISBN", new anchor.BN(232_000_000), nextSupplyDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pdas.yesMintPda,
        admin.publicKey
      );
      const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

      await placeBid({ ...pdas, ...obPdas }, admin.publicKey, adminUsdcAta, adminYes, 650_000, 1);

      await buyNo(
        { ...pdas, ...obPdas },
        userB.publicKey,
        userBUsdc,
        userBYes,
        userBNo,
        600_000,
        1,
        { signers: [userB] }
      );

      const yesMint = await getMint(connection, pdas.yesMintPda);
      const noMint = await getMint(connection, pdas.noMintPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);

      expect(Number(yesMint.supply)).to.equal(1);
      expect(Number(noMint.supply)).to.equal(1);
      expect(Number(yesMint.supply)).to.equal(Number(noMint.supply));
      expect(Number(yesMint.supply)).to.equal(market.totalPairsMinted.toNumber());
    });

    it("after atomic sell-no composition: unsettled yes_supply == no_supply == totalPairsMinted", async () => {
      const pdas = await createMarket("ISSN", new anchor.BN(233_000_000), nextSupplyDate());
      const obPdas = await initOrderBookForMarket(pdas.marketPda, pdas.yesMintPda);
      const adminYes = getAssociatedTokenAddressSync(pdas.yesMintPda, admin.publicKey);
      const { userYes: userBYes, userNo: userBNo } = tokenAccountsFor(userB.publicKey, pdas);

      await mintPairForAdmin({ ...pdas, ...obPdas }, 2);
      await mintPairForUser(userB.publicKey, userBUsdc, pdas, 2, [userB]);

      await placeAsk(
        { ...pdas, ...obPdas },
        admin.publicKey,
        adminUsdcAta,
        adminYes,
        400_000,
        2
      );

      await sellNo(
        { ...pdas, ...obPdas },
        userB.publicKey,
        userBUsdc,
        userBYes,
        userBNo,
        400_000,
        2,
        { signers: [userB] }
      );

      const yesMint = await getMint(connection, pdas.yesMintPda);
      const noMint = await getMint(connection, pdas.noMintPda);
      const market = await program.account.strikeMarket.fetch(pdas.marketPda);

      expect(Number(yesMint.supply)).to.equal(2);
      expect(Number(noMint.supply)).to.equal(2);
      expect(Number(yesMint.supply)).to.equal(Number(noMint.supply));
      expect(Number(yesMint.supply)).to.equal(market.totalPairsMinted.toNumber());
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  MULTI-MARKET ISOLATION INVARIANTS
  // ═══════════════════════════════════════════════════════════════

  describe("multi-market isolation invariants", () => {
    const connection = provider.connection;
    let userB: Keypair;
    let userBUsdc: PublicKey;
    let multiMarketIdx = 1600000100;

    function nextMultiMarketDate() {
      return new anchor.BN(multiMarketIdx++);
    }

    before(async () => {
      const funded = await createFundedUser(20_000_000);
      userB = funded.user;
      userBUsdc = funded.userUsdc;
    });

    it("keeps vaults, supplies, and order books isolated across concurrent market activity", async () => {
      const marketA = await createMarket("AAPL", new anchor.BN(236_000_000), nextMultiMarketDate());
      const marketB = await createMarket("MSFT", new anchor.BN(237_000_000), nextMultiMarketDate());
      const marketC = await createMarket("META", new anchor.BN(238_000_000), nextMultiMarketDate());

      await mintPairForAdmin(marketA, 3);
      const { userYes: userBYesB } = await mintPairForUser(
        userB.publicKey,
        userBUsdc,
        marketB,
        2,
        [userB]
      );
      const { userYes: adminYesC } = await mintPairForAdmin(marketC, 1);

      await burnPairForUser(admin.publicKey, adminUsdcAta, marketA, 1);
      await adminSettleMarket(marketB, new anchor.BN(300_000_000));
      await redeemForUser(
        marketB,
        userB.publicKey,
        userBUsdc,
        marketB.yesMintPda,
        userBYesB,
        1,
        [userB]
      );
      await placeBid(marketC, admin.publicKey, adminUsdcAta, adminYesC, 500_000, 1);

      const marketAState = await program.account.strikeMarket.fetch(marketA.marketPda);
      const marketBState = await program.account.strikeMarket.fetch(marketB.marketPda);
      const marketCState = await program.account.strikeMarket.fetch(marketC.marketPda);
      const marketAVault = await tokenAmount(marketA.vaultPda);
      const marketBVault = await tokenAmount(marketB.vaultPda);
      const marketCVault = await tokenAmount(marketC.vaultPda);
      const marketCBook = await program.account.orderBook.fetch(marketC.orderBookPda);
      const marketCObUsdc = await tokenAmount(marketC.obUsdcVault);
      const marketAYesMint = await getMint(connection, marketA.yesMintPda);
      const marketANoMint = await getMint(connection, marketA.noMintPda);
      const marketBYesMint = await getMint(connection, marketB.yesMintPda);
      const marketBNoMint = await getMint(connection, marketB.noMintPda);
      const marketCYesMint = await getMint(connection, marketC.yesMintPda);
      const marketCNoMint = await getMint(connection, marketC.noMintPda);

      expect(marketAState.outcome).to.deep.equal({ pending: {} });
      expect(marketAState.totalPairsMinted.toNumber()).to.equal(2);
      expect(marketAVault).to.equal(2_000_000);
      expect(Number(marketAYesMint.supply)).to.equal(2);
      expect(Number(marketANoMint.supply)).to.equal(2);

      expect(marketBState.outcome).to.deep.equal({ yesWins: {} });
      expect(marketBState.totalPairsMinted.toNumber()).to.equal(1);
      expect(marketBVault).to.equal(1_000_000);
      expect(Number(marketBYesMint.supply)).to.equal(1);
      expect(Number(marketBNoMint.supply)).to.equal(1);

      expect(marketCState.outcome).to.deep.equal({ pending: {} });
      expect(marketCState.totalPairsMinted.toNumber()).to.equal(1);
      expect(marketCVault).to.equal(1_000_000);
      expect(Number(marketCYesMint.supply)).to.equal(1);
      expect(Number(marketCNoMint.supply)).to.equal(1);
      expect(marketCBook.bidCount).to.equal(1);
      expect(marketCBook.askCount).to.equal(0);
      expect(marketCObUsdc).to.equal(500_000);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  SETTLEMENT IMMUTABILITY TESTS
  // ═══════════════════════════════════════════════════════════════

  describe("settlement immutability", () => {
    it("re-settling raises MarketAlreadySettled", async () => {
      const pdas = await createMarket("ISIM", new anchor.BN(240_000_000), new anchor.BN(1600000030));

      await adminSettleMarket(pdas, new anchor.BN(250_000_000));

      try {
        await program.methods
          .adminSettle(new anchor.BN(200_000_000))
          .accountsPartial({
            admin: admin.publicKey,
            config: configPda,
            market: pdas.marketPda,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MarketAlreadySettled");
      }
    });

    it("outcome does not change on re-fetch after settlement", async () => {
      const pdas = await createMarket("ISRF", new anchor.BN(241_000_000), new anchor.BN(1600000031));

      // Settle -> YesWins (price above strike)
      await adminSettleMarket(pdas, new anchor.BN(300_000_000));

      const market1 = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(market1.outcome).to.deep.equal({ yesWins: {} });

      // Re-fetch and verify immutable
      const market2 = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(market2.outcome).to.deep.equal({ yesWins: {} });
      expect(market2.settledAt.toNumber()).to.equal(market1.settledAt.toNumber());
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EDGE CASE TESTS
  // ═══════════════════════════════════════════════════════════════

  describe("edge cases", () => {
    const connection = provider.connection;

    // At-or-above rule: price exactly at strike -> YesWins
    it("oracle at exactly strike price -> YesWins (at-or-above rule)", async () => {
      const strikePrice = new anchor.BN(333_000_000);
      const pdas = await createMarket("EEXA", strikePrice, new anchor.BN(1600000040));

      await adminSettleMarket(pdas, new anchor.BN(333_000_000));

      const market = await program.account.strikeMarket.fetch(pdas.marketPda);
      expect(market.outcome).to.deep.equal({ yesWins: {} });
    });

    it("redeem losing tokens: burns tokens, user gets 0 USDC, vault unchanged", async () => {
      const pdas = await createMarket("ELOSE", new anchor.BN(334_000_000), new anchor.BN(1600000041));
      const { userNo } = userTokenAccounts(pdas);

      // Mint 3 pairs
      for (let i = 0; i < 3; i++) {
        await mintPairForAdmin(pdas, 1);
      }

      // Settle -> YesWins (No tokens are losers)
      await adminSettleMarket(pdas, new anchor.BN(400_000_000));

      const vaultBefore = Number((await getAccount(connection, pdas.vaultPda)).amount);
      const usdcBefore = Number((await getAccount(connection, adminUsdcAta)).amount);

      // Redeem 3 No tokens (loser)
      await redeemForUser(
        pdas,
        admin.publicKey,
        adminUsdcAta,
        pdas.noMintPda,
        userNo,
        3
      );

      const vaultAfter = Number((await getAccount(connection, pdas.vaultPda)).amount);
      const usdcAfter = Number((await getAccount(connection, adminUsdcAta)).amount);

      // Vault unchanged - loser tokens get 0 USDC
      expect(vaultAfter).to.equal(vaultBefore);
      expect(usdcAfter).to.equal(usdcBefore);

      // No tokens should be burned
      const noBalance = Number((await getAccount(connection, userNo)).amount);
      expect(noBalance).to.equal(0);
    });

    it("pre-settlement complete-set redeem returns exactly 1 USDC per pair", async () => {
      const pdas = await createMarket("EBRN", new anchor.BN(335_000_000), new anchor.BN(1600000042));

      // Mint 5 pairs
      for (let i = 0; i < 5; i++) {
        await mintPairForAdmin(pdas, 1);
      }

      const usdcBefore = Number((await getAccount(connection, adminUsdcAta)).amount);

      // Burn 3 pairs -> should get exactly 3 USDC back
      await burnPairForUser(admin.publicKey, adminUsdcAta, pdas, 3);

      const usdcAfter = Number((await getAccount(connection, adminUsdcAta)).amount);
      expect(usdcAfter - usdcBefore).to.equal(3 * 1_000_000); // exactly 3 USDC
    });
  });
});
