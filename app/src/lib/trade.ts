import { type Program, type BN } from "@coral-xyz/anchor";
import { type AccountMeta, PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
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

  // Ensure user has a Yes ATA (might not exist yet)
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userYesAta,
      user,
      yesMint
    )
  );

  const ix = await program.methods
    .placeOrder({ bid: {} }, price, quantity)
    .accountsPartial({
      user,
      market,
      orderBook,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      obUsdcVault,
      obYesVault,
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

  const ix = await program.methods
    .placeOrder({ ask: {} }, price, quantity)
    .accountsPartial({
      user,
      market,
      orderBook,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      obUsdcVault,
      obYesVault,
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

  // Step 1: Mint pairs (1 per call, need `quantity` pairs for the ask)
  const mintIx = await program.methods
    .mintPair()
    .accountsPartial({
      user,
      market,
      yesMint,
      noMint,
      vault,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      userNo: userNoAta,
    })
    .instruction();
  const qty = quantity.toNumber();
  for (let i = 0; i < qty; i++) tx.add(mintIx);

  // Step 2: Sell the Yes tokens on the order book
  const placeIx = await program.methods
    .placeOrder({ ask: {} }, price, quantity)
    .accountsPartial({
      user,
      market,
      orderBook,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      obUsdcVault,
      obYesVault,
    })
    .remainingAccounts(remaining)
    .instruction();
  tx.add(placeIx);

  return tx;
}

// Sell No = buy Yes from book + burn_pair (Yes+No -> $1.00 USDC)
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
  const [vault] = findVaultPda("vault", market);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

  // Sell No places a bid, so opposite side is asks
  const remaining = oppositeOrders
    ? buildRemainingAccounts("bid", price.toNumber(), quantity.toNumber(), oppositeOrders, usdcMint, yesMint)
    : [];

  const tx = new Transaction();

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userYesAta,
      user,
      yesMint
    )
  );

  // Step 1: Buy Yes tokens from the order book
  const placeIx = await program.methods
    .placeOrder({ bid: {} }, price, quantity)
    .accountsPartial({
      user,
      market,
      orderBook,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      obUsdcVault,
      obYesVault,
    })
    .remainingAccounts(remaining)
    .instruction();
  tx.add(placeIx);

  // Step 2: Burn Yes + No pair for $1.00 USDC
  const burnIx = await program.methods
    .burnPair(quantity)
    .accountsPartial({
      user,
      market,
      yesMint,
      noMint,
      vault,
      userUsdc: userUsdcAta,
      userYes: userYesAta,
      userNo: userNoAta,
    })
    .instruction();
  tx.add(burnIx);

  return tx;
}
