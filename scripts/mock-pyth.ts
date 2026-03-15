/**
 * Mock Pyth oracle helpers for localnet and tests.
 *
 * Creates on-chain PriceUpdateV2 accounts by writing raw Borsh bytes
 * via the mock-pyth program (deployed at the real Pyth Receiver address).
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AnchorProvider } from "@coral-xyz/anchor";

// ── Constants ────────────────────────────────────────────────────

/**
 * The Pyth Solana Receiver program ID.
 * Accounts owned by this program are accepted by settle_market's
 * `Account<'info, PriceUpdateV2>` constraint.
 */
export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
);

/**
 * PriceUpdateV2 Anchor account discriminator.
 * = first 8 bytes of sha256("account:PriceUpdateV2")
 */
export const PRICE_UPDATE_V2_DISCRIMINATOR = Buffer.from([
  34, 241, 35, 99, 157, 126, 244, 205,
]);

/** PriceUpdateV2 account size: 133 bytes */
export const PRICE_UPDATE_V2_SIZE = 133;

// ── Buffer builder ───────────────────────────────────────────────

/**
 * Build the raw Borsh-encoded bytes for a PriceUpdateV2 account.
 *
 * Layout (133 bytes total):
 *   8  discriminator
 *   32 write_authority (Pubkey)
 *   1  VerificationLevel (1 = Full)
 *   32 feed_id ([u8; 32])
 *   8  price (i64)
 *   8  conf (u64)
 *   4  exponent (i32)
 *   8  publish_time (i64)
 *   8  prev_publish_time (i64)
 *   8  ema_price (i64)
 *   8  ema_conf (u64)
 *   8  posted_slot (u64)
 */
export function buildMockPriceUpdateV2Data(params: {
  writeAuthority: PublicKey;
  feedId: number[]; // [u8; 32]
  priceDollars: number; // e.g. 150.00
  exponent: number; // e.g. -8 (price = priceDollars * 10^-exponent in Pyth units)
  publishTime: number; // unix timestamp
  postedSlot?: bigint;
}): Buffer {
  const buf = Buffer.alloc(PRICE_UPDATE_V2_SIZE, 0);
  let off = 0;

  PRICE_UPDATE_V2_DISCRIMINATOR.copy(buf, off);
  off += 8;

  params.writeAuthority.toBuffer().copy(buf, off);
  off += 32;

  // VerificationLevel::Full = discriminant 1, no payload
  buf.writeUInt8(1, off);
  off += 1;

  // feed_id [u8; 32]
  Buffer.from(params.feedId).copy(buf, off);
  off += 32;

  // price i64: dollars * 10^-exponent -> price * 10^8 if exponent == -8
  const rawPrice = BigInt(Math.round(params.priceDollars * Math.pow(10, -params.exponent)));
  buf.writeBigInt64LE(rawPrice, off);
  off += 8;

  // conf u64: 0.01% of price in the same units
  const rawConf = rawPrice / 10000n;
  buf.writeBigUInt64LE(rawConf, off);
  off += 8;

  // exponent i32
  buf.writeInt32LE(params.exponent, off);
  off += 4;

  // publish_time i64
  buf.writeBigInt64LE(BigInt(params.publishTime), off);
  off += 8;

  // prev_publish_time i64 (same as publish_time for mock)
  buf.writeBigInt64LE(BigInt(params.publishTime), off);
  off += 8;

  // ema_price i64 (same as price for mock)
  buf.writeBigInt64LE(rawPrice, off);
  off += 8;

  // ema_conf u64 (same as conf for mock)
  buf.writeBigUInt64LE(rawConf, off);
  off += 8;

  // posted_slot u64
  buf.writeBigUInt64LE(params.postedSlot ?? 0n, off);

  return buf;
}

// ── On-chain helpers ─────────────────────────────────────────────

/**
 * Create a mock PriceUpdateV2 account on localnet/test validator.
 *
 * Sends a single transaction that:
 *  1. Creates the account (owner = PYTH_RECEIVER_PROGRAM_ID)
 *  2. Writes the PriceUpdateV2 Borsh data via mock-pyth instruction
 *
 * @returns The public key of the created price update account
 */
export async function createMockPriceUpdate(
  provider: AnchorProvider,
  params: {
    feedId: number[]; // [u8; 32]
    priceDollars: number;
    exponent?: number;
    publishTime: number;
  }
): Promise<PublicKey> {
  const priceAccount = Keypair.generate();
  const exponent = params.exponent ?? -8;

  const data = buildMockPriceUpdateV2Data({
    writeAuthority: provider.wallet.publicKey,
    feedId: params.feedId,
    priceDollars: params.priceDollars,
    exponent,
    publishTime: params.publishTime,
  });

  const lamports = await provider.connection.getMinimumBalanceForRentExemption(
    PRICE_UPDATE_V2_SIZE
  );

  const tx = new Transaction().add(
    // 1. Create account owned by mock-pyth (= Pyth Receiver program ID)
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: priceAccount.publicKey,
      lamports,
      space: PRICE_UPDATE_V2_SIZE,
      programId: PYTH_RECEIVER_PROGRAM_ID,
    }),
    // 2. Write PriceUpdateV2 data via mock-pyth instruction
    new TransactionInstruction({
      programId: PYTH_RECEIVER_PROGRAM_ID,
      keys: [
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: priceAccount.publicKey, isSigner: false, isWritable: true },
      ],
      data,
    })
  );

  await provider.sendAndConfirm(tx, [priceAccount]);
  return priceAccount.publicKey;
}
