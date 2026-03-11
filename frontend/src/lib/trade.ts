import { type Program, type BN } from "@coral-xyz/anchor";
import {
  type AccountMeta,
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
import { type ParsedOrder } from "./orderbook";

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
  /** Active orders on the opposite side of the book (asks for bids, bids for asks). */
  oppositeOrders?: ParsedOrder[];
}

/**
 * Simulate fills against sorted opposite-side orders and return
 * counterparty ATAs as remainingAccounts.
 *
 * For bids filling asks: counterparty needs USDC (seller receives USDC)
 * For asks filling bids: counterparty needs Yes tokens (buyer receives Yes)
 */
function buildRemainingAccounts(
  side: "bid" | "ask",
  price: number,
  quantity: number,
  oppositeOrders: ParsedOrder[],
  usdcMint: PublicKey,
  yesMint: PublicKey,
): AccountMeta[] {
  const accounts: AccountMeta[] = [];
  let remaining = quantity;

  for (const order of oppositeOrders) {
    if (remaining <= 0) break;
    // Bids match asks priced <= bid price; asks match bids priced >= ask price
    if (side === "bid" && order.price > price) break;
    if (side === "ask" && order.price < price) break;

    // Bid fills ask -> counterparty (seller) gets USDC back
    // Ask fills bid -> counterparty (buyer) gets Yes tokens
    const mint = side === "bid" ? usdcMint : yesMint;
    const counterpartyAta = getAssociatedTokenAddressSync(mint, order.owner);
    accounts.push({ pubkey: counterpartyAta, isWritable: true, isSigner: false });

    remaining -= Math.min(remaining, order.quantity);
  }

  return accounts;
}

// Buy Yes = place a bid on the order book (USDC -> Yes tokens)
export async function buildBuyYesTx(
  params: TradeParams
): Promise<Transaction> {
  const { program, user, market, yesMint, usdcMint, price, quantity, oppositeOrders } =
    params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  const remaining = oppositeOrders
    ? buildRemainingAccounts("bid", price.toNumber(), quantity.toNumber(), oppositeOrders, usdcMint, yesMint)
    : [];

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
    .remainingAccounts(remaining)
    .instruction();

  tx.add(ix);
  return tx;
}

// Sell Yes = place an ask on the order book (Yes tokens -> USDC)
export async function buildSellYesTx(
  params: TradeParams
): Promise<Transaction> {
  const { program, user, market, yesMint, usdcMint, price, quantity, oppositeOrders } =
    params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  const remaining = oppositeOrders
    ? buildRemainingAccounts("ask", price.toNumber(), quantity.toNumber(), oppositeOrders, usdcMint, yesMint)
    : [];

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
    .remainingAccounts(remaining)
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
    oppositeOrders,
  } = params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const userNoAta = getAssociatedTokenAddressSync(noMint, user);
  const [vault] = findVaultPda("vault", market);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  // Buy No places an ask, so opposite side is bids
  const remaining = oppositeOrders
    ? buildRemainingAccounts("ask", price.toNumber(), quantity.toNumber(), oppositeOrders, usdcMint, yesMint)
    : [];

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
    .remainingAccounts(remaining)
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
    oppositeOrders,
  } = params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const userNoAta = getAssociatedTokenAddressSync(noMint, user);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  const remaining = oppositeOrders
    ? buildRemainingAccounts("bid", price.toNumber(), quantity.toNumber(), oppositeOrders, usdcMint, yesMint)
    : [];

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
    .remainingAccounts(remaining)
    .instruction();
  tx.add(buyIx);

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
