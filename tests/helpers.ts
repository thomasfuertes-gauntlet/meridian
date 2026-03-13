import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Meridian } from "../target/types/meridian";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createMint,
  createAssociatedTokenAccount,
  createTransferInstruction,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const supportedTickers = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

export interface TestContext {
  provider: anchor.AnchorProvider;
  program: Program<Meridian>;
  methods: any;
  admin: anchor.Wallet;
  configPda: PublicKey;
  configBump: number;
  usdcMint: PublicKey;
  mintAuthority: Keypair;
  adminUsdcAta: PublicKey;
  uniqueTestSeedBase: number;
}

let cachedCtx: TestContext | null = null;

export async function setupTestContext(): Promise<TestContext> {
  if (cachedCtx) return cachedCtx;

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
  const admin = provider.wallet as anchor.Wallet;
  const methods = program.methods as any;

  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const mintAuthority = Keypair.generate();
  const sig = await provider.connection.requestAirdrop(
    mintAuthority.publicKey,
    2 * anchor.web3.LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(sig);

  const usdcMint = await createMint(
    provider.connection,
    mintAuthority,
    mintAuthority.publicKey,
    null,
    6
  );

  const adminUsdcAta = await createAssociatedTokenAccount(
    provider.connection,
    mintAuthority,
    usdcMint,
    admin.publicKey
  );
  await mintTo(
    provider.connection,
    mintAuthority,
    usdcMint,
    adminUsdcAta,
    mintAuthority,
    1_000_000_000
  );

  // Ensure globalConfig is initialized
  const existing = await program.account.globalConfig.fetchNullable(configPda);
  if (!existing) {
    await program.methods
      .initializeConfig()
      .accountsPartial({ admin: admin.publicKey })
      .rpc();
  }

  cachedCtx = {
    provider,
    program,
    methods,
    admin,
    configPda,
    configBump,
    usdcMint,
    mintAuthority,
    adminUsdcAta,
    uniqueTestSeedBase,
  };
  return cachedCtx;
}

// ── PDA helpers ──────────────────────────────────────────────────

export function deriveMarketPdas(
  ctx: TestContext,
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
    ctx.program.programId
  );
  const [yesMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_mint"), marketPda.toBuffer()],
    ctx.program.programId
  );
  const [noMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("no_mint"), marketPda.toBuffer()],
    ctx.program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPda.toBuffer()],
    ctx.program.programId
  );
  const [orderBookPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook"), marketPda.toBuffer()],
    ctx.program.programId
  );
  const [obUsdcVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("ob_usdc_vault"), marketPda.toBuffer()],
    ctx.program.programId
  );
  const [obYesVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("ob_yes_vault"), marketPda.toBuffer()],
    ctx.program.programId
  );
  return { marketPda, yesMintPda, noMintPda, vaultPda, orderBookPda, obUsdcVault, obYesVault };
}

export function deriveOrderBookPdas(ctx: TestContext, marketPda: PublicKey) {
  const [orderBookPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook"), marketPda.toBuffer()],
    ctx.program.programId
  );
  const [obUsdcVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("ob_usdc_vault"), marketPda.toBuffer()],
    ctx.program.programId
  );
  const [obYesVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("ob_yes_vault"), marketPda.toBuffer()],
    ctx.program.programId
  );
  return { orderBookPda, obUsdcVault, obYesVault };
}

// ── Ticker / date helpers ────────────────────────────────────────

export function normalizeTicker(ticker: string): string {
  if (supportedTickers.includes(ticker)) return ticker;
  let sum = 0;
  for (const ch of ticker) sum += ch.charCodeAt(0);
  return supportedTickers[sum % supportedTickers.length];
}

export function closeTimeAfter(date: anchor.BN, seconds = 3600): anchor.BN {
  return date.add(new anchor.BN(seconds));
}

// ── Market creation ──────────────────────────────────────────────

export async function createMarket(
  ctx: TestContext,
  ticker: string,
  strikePrice: anchor.BN,
  date: anchor.BN,
  closeTime?: anchor.BN
) {
  const normalizedTicker = normalizeTicker(ticker);
  const pdas = deriveMarketPdas(ctx, normalizedTicker, strikePrice, date);
  await ctx.program.methods
    .createStrikeMarket(
      normalizedTicker,
      strikePrice,
      date,
      closeTime ?? closeTimeAfter(date)
    )
    .accountsPartial({
      admin: ctx.admin.publicKey,
      usdcMint: ctx.usdcMint,
    })
    .rpc();
  return pdas;
}

// create_strike_market creates the order book inline; this is just PDA derivation.
export function initOrderBookForMarket(
  ctx: TestContext,
  marketPda: PublicKey,
  _yesMintPda?: PublicKey
) {
  return deriveOrderBookPdas(ctx, marketPda);
}

// ── Token account helpers ────────────────────────────────────────

export function tokenAccountsFor(
  owner: PublicKey,
  market: ReturnType<typeof deriveMarketPdas>
) {
  return {
    userYes: getAssociatedTokenAddressSync(market.yesMintPda, owner),
    userNo: getAssociatedTokenAddressSync(market.noMintPda, owner),
  };
}

export function userTokenAccounts(ctx: TestContext, market: ReturnType<typeof deriveMarketPdas>) {
  return tokenAccountsFor(ctx.admin.publicKey, market);
}

export async function tokenAmount(ctx: TestContext, account: PublicKey) {
  return Number((await getAccount(ctx.provider.connection, account)).amount);
}

export function expectIncrease(before: number, after: number, expectedDelta: number) {
  const { expect } = require("chai");
  expect(after - before).to.equal(expectedDelta);
}

export function expectDecrease(before: number, after: number, expectedDelta: number) {
  const { expect } = require("chai");
  expect(before - after).to.equal(expectedDelta);
}

// ── USDC / token minting ─────────────────────────────────────────

export async function mintUsdc(ctx: TestContext, dest: PublicKey, amount: number) {
  await mintTo(
    ctx.provider.connection,
    ctx.mintAuthority,
    ctx.usdcMint,
    dest,
    ctx.mintAuthority,
    amount
  );
}

export async function createFundedUser(ctx: TestContext, usdcAmount = 20_000_000) {
  const user = Keypair.generate();
  const sig = await ctx.provider.connection.requestAirdrop(
    user.publicKey,
    2 * anchor.web3.LAMPORTS_PER_SOL
  );
  await ctx.provider.connection.confirmTransaction(sig);
  const userUsdc = await createAssociatedTokenAccount(
    ctx.provider.connection,
    ctx.mintAuthority,
    ctx.usdcMint,
    user.publicKey
  );
  await mintUsdc(ctx, userUsdc, usdcAmount);
  return { user, userUsdc };
}

// ── Mint / burn pair ─────────────────────────────────────────────

export async function mintPairForAdmin(
  ctx: TestContext,
  market: ReturnType<typeof deriveMarketPdas>,
  amount = 1
) {
  return mintPairForUser(ctx, ctx.admin.publicKey, ctx.adminUsdcAta, market, amount);
}

export async function mintPairForUser(
  ctx: TestContext,
  user: PublicKey,
  userUsdcAta: PublicKey,
  market: ReturnType<typeof deriveMarketPdas>,
  amount = 1,
  signers?: Keypair[]
) {
  const { userYes: ownerYes, userNo: ownerNo } = tokenAccountsFor(user, market);
  const tx = ctx.methods
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

export async function burnPairForUser(
  ctx: TestContext,
  user: PublicKey,
  userUsdcAta: PublicKey,
  market: ReturnType<typeof deriveMarketPdas>,
  amount = 1,
  signers?: Keypair[]
) {
  const { userYes: ownerYes, userNo: ownerNo } = tokenAccountsFor(user, market);
  const tx = ctx.methods
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

export async function redeemForUser(
  ctx: TestContext,
  market: ReturnType<typeof deriveMarketPdas>,
  user: PublicKey,
  userUsdc: PublicKey,
  tokenMint: PublicKey,
  userToken: PublicKey,
  amount: number,
  signers?: Keypair[],
  remainingAccounts?: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[]
) {
  const tx = ctx.methods
    .redeem(new anchor.BN(amount))
    .accountsPartial({
      user,
      market: market.marketPda,
      userUsdc,
      vault: market.vaultPda,
      tokenMint,
      userToken,
    });
  if (remainingAccounts) tx.remainingAccounts(remainingAccounts);
  if (signers) {
    await tx.signers(signers).rpc();
  } else {
    await tx.rpc();
  }
}

// ── Market control ───────────────────────────────────────────────

export async function freezeMarket(
  ctx: TestContext,
  market: ReturnType<typeof deriveMarketPdas>
) {
  await ctx.methods
    .freezeMarket()
    .accountsPartial({
      authority: ctx.admin.publicKey,
      config: ctx.configPda,
      market: market.marketPda,
    })
    .rpc();
}

export async function pauseProtocol(
  ctx: TestContext,
  adminSigner: PublicKey = ctx.admin.publicKey,
  signers?: Keypair[]
) {
  const tx = ctx.program.methods.pause().accountsPartial({ admin: adminSigner });
  if (signers) {
    await tx.signers(signers).rpc();
  } else {
    await tx.rpc();
  }
}

export async function unpauseProtocol(
  ctx: TestContext,
  adminSigner: PublicKey = ctx.admin.publicKey,
  signers?: Keypair[]
) {
  const tx = ctx.program.methods.unpause().accountsPartial({ admin: adminSigner });
  if (signers) {
    await tx.signers(signers).rpc();
  } else {
    await tx.rpc();
  }
}

export function settlementProofAccounts(market: { orderBookPda: PublicKey }) {
  return [
    { pubkey: market.orderBookPda, isWritable: true, isSigner: false },
  ];
}

export async function adminSettleMarket(
  ctx: TestContext,
  market: ReturnType<typeof deriveMarketPdas>,
  price: anchor.BN
) {
  await freezeMarket(ctx, market);
  await ctx.methods
    .adminSettle(price)
    .accountsPartial({
      admin: ctx.admin.publicKey,
      config: ctx.configPda,
      market: market.marketPda,
    })
    .remainingAccounts(settlementProofAccounts(market))
    .rpc();
}

export async function settleWithOrderBookProof(
  ctx: TestContext,
  market: ReturnType<typeof deriveMarketPdas> & {
    orderBookPda: PublicKey;
    obUsdcVault: PublicKey;
    obYesVault: PublicKey;
  },
  price: anchor.BN
) {
  await ctx.methods
    .adminSettle(price)
    .accountsPartial({
      admin: ctx.admin.publicKey,
      config: ctx.configPda,
      market: market.marketPda,
    })
    .remainingAccounts(settlementProofAccounts(market))
    .rpc();
}

export async function unwindOrderForSettlement(
  ctx: TestContext,
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
  const tx = ctx.methods
    .unwindOrder(orderId instanceof anchor.BN ? orderId : new anchor.BN(orderId))
    .accountsPartial({
      authority: signer?.publicKey ?? ctx.admin.publicKey,
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

// ── CLOB order helpers ───────────────────────────────────────────

export async function placeBid(
  ctx: TestContext,
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
  options?: { signers?: Keypair[] }
) {
  const tx = ctx.program.methods
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

export async function placeAsk(
  ctx: TestContext,
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
  options?: { signers?: Keypair[] }
) {
  const tx = ctx.program.methods
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

export async function buyYes(
  ctx: TestContext,
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
  options?: { signers?: Keypair[] }
) {
  const tx = ctx.methods
    .buyYes(new anchor.BN(amount), new anchor.BN(maxPrice))
    .accountsPartial({
      user,
      config: ctx.configPda,
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

export async function sellYes(
  ctx: TestContext,
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
  options?: { signers?: Keypair[] }
) {
  const tx = ctx.methods
    .sellYes(new anchor.BN(amount), new anchor.BN(minPrice))
    .accountsPartial({
      user,
      config: ctx.configPda,
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

export async function claimFills(
  ctx: TestContext,
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
  const tx = ctx.methods
    .claimFills()
    .accountsPartial({
      payer: ctx.admin.publicKey,
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

export async function buyNo(
  ctx: TestContext,
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
  options?: { signers?: Keypair[] }
) {
  const mintIx = await ctx.methods
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

  const sellIx = await ctx.methods
    .sellYes(new anchor.BN(amount), new anchor.BN(maxNetCost))
    .accountsPartial({
      user,
      config: ctx.configPda,
      market: market.marketPda,
      userUsdc,
      userYes,
      orderBook: market.orderBookPda,
      obUsdcVault: market.obUsdcVault,
      obYesVault: market.obYesVault,
    })
    .instruction();

  const tx = new anchor.web3.Transaction().add(mintIx, sellIx);
  await ctx.provider.sendAndConfirm(tx, options?.signers ?? []);
}

export async function sellNo(
  ctx: TestContext,
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
  options?: { signers?: Keypair[] }
) {
  const buyIx = await ctx.methods
    .buyYes(new anchor.BN(amount), new anchor.BN(minNetPrice))
    .accountsPartial({
      user,
      config: ctx.configPda,
      market: market.marketPda,
      userUsdc,
      yesMint: market.yesMintPda,
      userYes,
      orderBook: market.orderBookPda,
      obUsdcVault: market.obUsdcVault,
      obYesVault: market.obYesVault,
    })
    .instruction();

  const redeemIx = await ctx.methods
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
  await ctx.provider.sendAndConfirm(tx, options?.signers ?? []);
}

export async function transferTokens(
  ctx: TestContext,
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: number,
  signers?: Keypair[]
) {
  const tx = new anchor.web3.Transaction().add(
    createTransferInstruction(source, destination, owner, amount)
  );
  await ctx.provider.sendAndConfirm(tx, signers ?? []);
}

export async function getCurrentUnixTimestamp(ctx: TestContext): Promise<number> {
  const slot = await ctx.provider.connection.getSlot("confirmed");
  const blockTime = await ctx.provider.connection.getBlockTime(slot);
  if (blockTime === null) throw new Error("Failed to fetch block time");
  return blockTime;
}
