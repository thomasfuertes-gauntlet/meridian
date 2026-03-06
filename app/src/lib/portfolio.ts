import { type Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { type Connection } from "@solana/web3.js";
import { USDC_PER_PAIR } from "./constants";

export interface Position {
  market: PublicKey;
  ticker: string;
  strikePrice: number;
  date: number;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  bump: number;
  yesBalance: number;
  noBalance: number;
  settled: boolean;
  outcome: "pending" | "yesWins" | "noWins";
  settlementPrice?: number;
}

// Fetch all positions for a wallet across all markets
export async function fetchPositions(
  program: Program,
  connection: Connection,
  wallet: PublicKey
): Promise<Position[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets = await (program.account as any).strikeMarket.all();
  const positions: Position[] = [];

  // Batch fetch all token accounts for this wallet
  const tokenAccounts = await connection.getTokenAccountsByOwner(wallet, {
    programId: TOKEN_PROGRAM_ID,
  });

  // Build a mint -> balance map
  const balanceMap = new Map<string, number>();
  for (const { account } of tokenAccounts.value) {
    const data = account.data;
    // SPL Token layout: mint (32 bytes), owner (32 bytes), amount (8 bytes LE)
    const mint = new PublicKey(data.subarray(0, 32));
    const amount = Number(data.readBigUInt64LE(64));
    if (amount > 0) {
      balanceMap.set(mint.toString(), amount);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of allMarkets as any[]) {
    const yesMint = m.account.yesMint as PublicKey;
    const noMint = m.account.noMint as PublicKey;
    const yesBalance = balanceMap.get(yesMint.toString()) ?? 0;
    const noBalance = balanceMap.get(noMint.toString()) ?? 0;

    if (yesBalance === 0 && noBalance === 0) continue;

    const outcome = m.account.outcome;
    let outcomeStr: "pending" | "yesWins" | "noWins" = "pending";
    if (outcome?.yesWins !== undefined) outcomeStr = "yesWins";
    else if (outcome?.noWins !== undefined) outcomeStr = "noWins";

    positions.push({
      market: m.publicKey,
      ticker: m.account.ticker as string,
      strikePrice: m.account.strikePrice.toNumber(),
      date: m.account.date.toNumber(),
      yesMint,
      noMint,
      vault: m.account.vault as PublicKey,
      bump: m.account.bump as number,
      yesBalance,
      noBalance,
      settled: outcomeStr !== "pending",
      outcome: outcomeStr,
    });
  }

  return positions;
}

// Build redeem TX for winning tokens
export async function buildRedeemTx(
  program: Program,
  user: PublicKey,
  market: PublicKey,
  tokenMint: PublicKey, // yes_mint or no_mint
  usdcMint: PublicKey,
  amount: number
): Promise<Transaction> {
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
  const userToken = getAssociatedTokenAddressSync(tokenMint, user);

  const tx = new Transaction();

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdc,
      user,
      usdcMint
    )
  );

  const ix = await program.methods
    .redeem(new BN(amount))
    .accountsPartial({
      user,
      market,
      userUsdc,
      tokenMint,
      userToken,
    })
    .instruction();

  tx.add(ix);
  return tx;
}

// Build burn_pair TX for pre-settlement exit
export async function buildBurnPairTx(
  program: Program,
  user: PublicKey,
  market: PublicKey,
  yesMint: PublicKey,
  noMint: PublicKey,
  usdcMint: PublicKey,
  amount: number
): Promise<Transaction> {
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user);
  const userYes = getAssociatedTokenAddressSync(yesMint, user);
  const userNo = getAssociatedTokenAddressSync(noMint, user);

  const tx = new Transaction();

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdc,
      user,
      usdcMint
    )
  );

  const ix = await program.methods
    .burnPair(new BN(amount))
    .accountsPartial({
      user,
      market,
      userUsdc,
      yesMint,
      noMint,
      userYes,
      userNo,
    })
    .instruction();

  tx.add(ix);
  return tx;
}

// Check if user holds conflicting tokens for a market
export function getPositionConflict(
  balanceMap: Map<string, number>,
  yesMint: PublicKey,
  noMint: PublicKey,
  action: "buyYes" | "buyNo" | "sellYes" | "sellNo"
): string | null {
  const yesBalance = balanceMap.get(yesMint.toString()) ?? 0;
  const noBalance = balanceMap.get(noMint.toString()) ?? 0;

  if (action === "buyYes" && noBalance > 0) {
    return `You hold ${noBalance} No token${noBalance > 1 ? "s" : ""}. Sell your No position first.`;
  }
  if (action === "buyNo" && yesBalance > 0) {
    return `You hold ${yesBalance} Yes token${yesBalance > 1 ? "s" : ""}. Sell your Yes position first.`;
  }
  return null;
}

export function formatUsdcPrice(baseUnits: number): string {
  return `$${(baseUnits / USDC_PER_PAIR).toFixed(2)}`;
}
