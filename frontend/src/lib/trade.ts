import { type Program, type BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PROGRAM_ID } from "./constants";

function findOrderBookPda(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook"), market.toBuffer()],
    PROGRAM_ID
  );
}

function findVaultPda(
  prefix: string,
  market: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(prefix), market.toBuffer()],
    PROGRAM_ID
  );
}

interface TradeParams {
  program: Program;
  user: PublicKey;
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcMint: PublicKey;
  price: BN;
  quantity: BN;
}

// Buy Yes = place a bid on the order book (USDC -> Yes tokens)
export async function buildBuyYesTx(
  params: TradeParams
): Promise<Transaction> {
  const { program, user, market, yesMint, usdcMint, price, quantity } =
    params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  const tx = new Transaction();

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdcAta,
      user,
      usdcMint
    )
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userYesAta,
      user,
      yesMint
    )
  );

  const ix = await program.methods
    .buyYes(quantity, price)
    .accountsPartial({
      user,
      market,
      userUsdc: userUsdcAta,
      yesMint,
      userYes: userYesAta,
      orderBook,
      obUsdcVault,
      obYesVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  tx.add(ix);
  return tx;
}

// Sell Yes = place an ask on the order book (Yes tokens -> USDC)
export async function buildSellYesTx(
  params: TradeParams
): Promise<Transaction> {
  const { program, user, market, yesMint, usdcMint, price, quantity } =
    params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  const tx = new Transaction();

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdcAta,
      user,
      usdcMint
    )
  );

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userYesAta,
      user,
      yesMint
    )
  );

  const ix = await program.methods
    .sellYes(quantity, price)
    .accountsPartial({
      user,
      market,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      orderBook,
      obUsdcVault,
      obYesVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  tx.add(ix);
  return tx;
}

// Buy No = mint_pair (get Yes+No) + place ask for Yes (sell Yes, keep No)
export async function buildBuyNoTx(
  params: TradeParams
): Promise<Transaction> {
  const {
    program,
    user,
    market,
    yesMint,
    noMint,
    usdcMint,
    price,
    quantity,
  } = params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const userNoAta = getAssociatedTokenAddressSync(noMint, user);
  const [vault] = findVaultPda("vault", market);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  const tx = new Transaction();

  // Ensure ATAs exist
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdcAta,
      user,
      usdcMint
    )
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userYesAta,
      user,
      yesMint
    )
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userNoAta,
      user,
      noMint
    )
  );

  // Step 1: Mint the collateralized pair through the canonical lifecycle entrypoint.
  const mintIx = await program.methods
    .mintPair(quantity)
    .accountsPartial({
      user,
      market,
      userUsdc: userUsdcAta,
      vault,
      yesMint,
      noMint,
      userYes: userYesAta,
      userNo: userNoAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  tx.add(mintIx);

  // Step 2: Sell the freshly minted Yes into the bid side of the single Yes/USDC book.
  const sellIx = await program.methods
    .sellYes(quantity, price)
    .accountsPartial({
      user,
      market,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      orderBook,
      obUsdcVault,
      obYesVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(sellIx);

  return tx;
}

// Sell No = buy Yes from the ask side, then redeem the complete set through the
// canonical redeem instruction.
export async function buildSellNoTx(
  params: TradeParams
): Promise<Transaction> {
  const {
    program,
    user,
    market,
    yesMint,
    noMint,
    usdcMint,
    price,
    quantity,
  } = params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const userNoAta = getAssociatedTokenAddressSync(noMint, user);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  const tx = new Transaction();

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdcAta,
      user,
      usdcMint
    )
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userYesAta,
      user,
      yesMint
    )
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userNoAta,
      user,
      noMint
    )
  );

  const buyIx = await program.methods
    .buyYes(quantity, price)
    .accountsPartial({
      user,
      market,
      userUsdc: userUsdcAta,
      yesMint,
      userYes: userYesAta,
      orderBook,
      obUsdcVault,
      obYesVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  tx.add(buyIx);

  // redeem still uses remainingAccounts for noMint/noAta - intentional
  const redeemIx = await program.methods
    .redeem(quantity)
    .accountsPartial({
      user,
      market,
      userUsdc: userUsdcAta,
      tokenMint: yesMint,
      userToken: userYesAta,
    })
    .remainingAccounts([
      { pubkey: noMint, isWritable: true, isSigner: false },
      { pubkey: userNoAta, isWritable: true, isSigner: false },
    ])
    .instruction();
  tx.add(redeemIx);

  return tx;
}

// Place a resting limit order (maker-only - will not cross the book)
export async function buildPlaceOrderTx(
  params: TradeParams,
  side: "bid" | "ask",
): Promise<Transaction> {
  const { program, user, market, yesMint, usdcMint, price, quantity } = params;

  const [orderBook] = findOrderBookPda(market);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, usdcMint));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userYesAta, user, yesMint));

  const ix = await program.methods
    .placeOrder(side === "bid" ? { bid: {} } : { ask: {} }, price, quantity)
    .accountsPartial({
      user,
      market,
      orderBook,
      obUsdcVault,
      obYesVault,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  tx.add(ix);
  return tx;
}

// Buy No via limit: mint pairs (get Yes+No), place resting ask for Yes, keep No
export async function buildBuyNoLimitTx(
  params: TradeParams,
): Promise<Transaction> {
  const { program, user, market, yesMint, noMint, usdcMint, price, quantity } = params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const userNoAta = getAssociatedTokenAddressSync(noMint, user);
  const [vault] = findVaultPda("vault", market);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, usdcMint));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userYesAta, user, yesMint));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, userNoAta, user, noMint));

  const mintIx = await program.methods
    .mintPair(quantity)
    .accountsPartial({
      user,
      market,
      userUsdc: userUsdcAta,
      vault,
      yesMint,
      noMint,
      userYes: userYesAta,
      userNo: userNoAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  tx.add(mintIx);

  const askIx = await program.methods
    .placeOrder({ ask: {} }, price, quantity)
    .accountsPartial({
      user,
      market,
      orderBook,
      obUsdcVault,
      obYesVault,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(askIx);

  return tx;
}

// Cancel a resting order by ID. Refunds escrowed USDC (bids) or Yes (asks).
export async function buildCancelOrderTx(
  program: Program,
  user: PublicKey,
  market: PublicKey,
  yesMint: PublicKey,
  usdcMint: PublicKey,
  orderId: number,
  side: "bid" | "ask",
): Promise<Transaction> {
  const [orderBook] = findOrderBookPda(market);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);
  // Bids refund USDC, asks refund Yes tokens
  const refundMint = side === "bid" ? usdcMint : yesMint;
  const refundDestination = getAssociatedTokenAddressSync(refundMint, user);

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(user, refundDestination, user, refundMint));

  const ix = await program.methods
    .cancelOrder(new (await import("@coral-xyz/anchor")).BN(orderId))
    .accountsPartial({
      user,
      market,
      orderBook,
      obUsdcVault,
      obYesVault,
      refundDestination,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(ix);
  return tx;
}

// Claim credited fills from the order book (permissionless - anyone can crank)
export async function buildClaimFillsTx(
  program: Program,
  payer: PublicKey,
  market: PublicKey,
  yesMint: PublicKey,
  usdcMint: PublicKey,
  owner: PublicKey,
): Promise<Transaction> {
  const [orderBook] = findOrderBookPda(market);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);
  const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, owner);
  const ownerYes = getAssociatedTokenAddressSync(yesMint, owner);

  const tx = new Transaction();

  // Ensure owner ATAs exist (payer creates if needed)
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(payer, ownerUsdc, owner, usdcMint)
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(payer, ownerYes, owner, yesMint)
  );

  const ix = await program.methods
    .claimFills()
    .accountsPartial({
      payer,
      market,
      orderBook,
      obUsdcVault,
      obYesVault,
      owner,
      ownerUsdc,
      ownerYes,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  tx.add(ix);

  return tx;
}
