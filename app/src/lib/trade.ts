import { type Program, type BN } from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
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
      userTokenAccount: userUsdcAta,
      userYesAccount: userYesAta,
      obUsdcVault,
      obYesVault,
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

  const ix = await program.methods
    .placeOrder({ ask: {} }, price, quantity)
    .accountsPartial({
      user,
      market,
      orderBook,
      userTokenAccount: userYesAta,
      userYesAccount: userYesAta,
      obUsdcVault,
      obYesVault,
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

  // Step 1: Mint pair (deposits 1 USDC, gets 1 Yes + 1 No per quantity)
  const mintIx = await program.methods
    .mintPair(quantity)
    .accountsPartial({
      user,
      market,
      yesMint,
      noMint,
      vault,
      userUsdcAccount: userUsdcAta,
      userYesAccount: userYesAta,
      userNoAccount: userNoAta,
    })
    .instruction();
  tx.add(mintIx);

  // Step 2: Sell the Yes tokens on the order book
  const placeIx = await program.methods
    .placeOrder({ ask: {} }, price, quantity)
    .accountsPartial({
      user,
      market,
      orderBook,
      userTokenAccount: userYesAta,
      userYesAccount: userYesAta,
      obUsdcVault,
      obYesVault,
    })
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
  } = params;

  const [orderBook] = findOrderBookPda(market);
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user);
  const userNoAta = getAssociatedTokenAddressSync(noMint, user);
  const [vault] = findVaultPda("vault", market);
  const [obUsdcVault] = findVaultPda("ob_usdc_vault", market);
  const [obYesVault] = findVaultPda("ob_yes_vault", market);

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
      userTokenAccount: userUsdcAta,
      userYesAccount: userYesAta,
      obUsdcVault,
      obYesVault,
    })
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
      userUsdcAccount: userUsdcAta,
      userYesAccount: userYesAta,
      userNoAccount: userNoAta,
    })
    .instruction();
  tx.add(burnIx);

  return tx;
}
