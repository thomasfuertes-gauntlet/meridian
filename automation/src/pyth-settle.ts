/**
 * Pyth oracle settlement helper.
 *
 * Fetches a price update from Hermes at close_time+30s (historical endpoint),
 * posts it on-chain via the Pyth Solana Receiver (full Wormhole verification),
 * then calls settle_market on the given market.
 *
 * Throws on any failure - callers should fall back to admin_settle.
 *
 * KEY-DECISION 2026-03-14: Use historical Hermes endpoint at close_time+30 rather
 * than "latest". The on-chain settle_market requires publish_time >= close_time;
 * fetching "latest" at 4:07 PM would have publish_time ~4:07 PM, outside the
 * 300s settlement window [close_time, close_time+300].
 *
 * KEY-DECISION 2026-03-14: Use buildPostPriceUpdateInstructions (full Wormhole
 * verification) rather than the "atomic" partial path. settle_market on-chain
 * enforces VerificationLevel::Full.
 *
 * DEVNET NOTE: For devnet Solana, set HERMES_URL=https://hermes-beta.pyth.network
 * to get Wormhole-devnet-compatible VAAs. The default hermes.pyth.network uses
 * mainnet Wormhole guardian set. If hermes-beta lacks the equity feed data
 * needed, settle_market will throw and admin_settle handles settlement instead.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Connection,
  Transaction,
  TransactionInstruction,
  Signer,
} from "@solana/web3.js";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

interface HermesBinaryResponse {
  binary: { encoding: string; data: string[] };
  parsed?: Array<{
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
  }>;
}

/**
 * Fetch price update binary (accumulator update data) from Hermes at a specific
 * unix timestamp. Returns [base64Data, publishTime].
 */
async function fetchHermesUpdate(
  feedId: string,
  targetTimestamp: number,
  hermesUrl: string
): Promise<[string, number]> {
  const cleanId = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  const url = `${hermesUrl}/v2/updates/price/${targetTimestamp}?ids[]=${cleanId}&encoding=base64`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Hermes returned ${response.status} for feed ${cleanId} at ts=${targetTimestamp}`
    );
  }

  const data = (await response.json()) as HermesBinaryResponse;
  if (!data.binary?.data?.[0]) {
    throw new Error(`No binary data in Hermes response for feed ${cleanId}`);
  }

  const publishTime = data.parsed?.[0]?.price?.publish_time ?? 0;
  return [data.binary.data[0], publishTime];
}

/**
 * Send an array of instructions sequentially, each in its own legacy transaction,
 * waiting for confirmation before the next. Required for Pyth VAA posting where
 * WriteEncodedVaa chunks → VerifyEncodedVaa → PostUpdate must be ordered.
 */
async function sendInstructionsSequentially(
  connection: Connection,
  payer: Keypair,
  instructions: { instruction: TransactionInstruction; signers: Signer[] }[]
): Promise<void> {
  for (const { instruction, signers } of instructions) {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(instruction);
    tx.sign(payer, ...signers);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
  }
}

/**
 * Attempt oracle-based settlement via settle_market (permissionless).
 *
 * Flow:
 * 1. Fetch historical VAA from Hermes at close_time + 30s
 * 2. Validate publish_time is within settlement window [close_time, close_time+300]
 * 3. Post the VAA on-chain (full Wormhole verification → VerificationLevel::Full)
 * 4. Call settle_market with the posted PriceUpdateV2 account
 * 5. Close ephemeral price update accounts to recover rent (best effort)
 *
 * @throws on any failure - caller should fall back to admin_settle
 * @returns settle_market transaction signature
 */
export async function oracleSettle(
  connection: Connection,
  admin: Keypair,
  program: anchor.Program,
  marketPubkey: PublicKey,
  feedId: string,
  closeTimeSecs: number,
  hermesUrl: string
): Promise<string> {
  const targetTimestamp = closeTimeSecs + 30;
  const [vaaBase64, publishTime] = await fetchHermesUpdate(
    feedId,
    targetTimestamp,
    hermesUrl
  );

  console.log(
    `[oracle-settle] VAA publish_time=${publishTime}, settlement window=[${closeTimeSecs}, ${closeTimeSecs + 300}]`
  );

  if (publishTime < closeTimeSecs || publishTime > closeTimeSecs + 300) {
    throw new Error(
      `VAA publish_time ${publishTime} outside settlement window ` +
        `[${closeTimeSecs}, ${closeTimeSecs + 300}]. ` +
        `Regular session feeds stop publishing at ~4:00 PM ET. ` +
        `Set HERMES_URL=https://hermes-beta.pyth.network and use post-market feed IDs for reliable devnet settlement.`
    );
  }

  const wallet = new anchor.Wallet(admin);
  const pythReceiver = new PythSolanaReceiver({ connection, wallet });

  // Full Wormhole verification path → VerificationLevel::Full on the resulting
  // PriceUpdateV2 account, which settle_market enforces on-chain.
  const { postInstructions, priceFeedIdToPriceUpdateAccount, closeInstructions } =
    await pythReceiver.buildPostPriceUpdateInstructions([vaaBase64]);

  // SDK keys the map with "0x" prefix
  const feedKey = feedId.startsWith("0x") ? feedId : `0x${feedId}`;
  const priceUpdateAccount = priceFeedIdToPriceUpdateAccount[feedKey];
  if (!priceUpdateAccount) {
    throw new Error(
      `PriceUpdateV2 account not found for feed ${feedKey}. ` +
        `Available keys: ${Object.keys(priceFeedIdToPriceUpdateAccount).join(", ")}`
    );
  }

  // Post the VAA. Must be sequential: each chunk confirmation gates the next.
  await sendInstructionsSequentially(connection, admin, postInstructions);

  const [orderBookPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("orderbook"), marketPubkey.toBuffer()],
    program.programId
  );

  const settleSig = await program.methods
    .settleMarket()
    .accountsPartial({
      settler: admin.publicKey,
      market: marketPubkey,
      priceUpdate: priceUpdateAccount,
    })
    .remainingAccounts([
      { pubkey: orderBookPda, isSigner: false, isWritable: true },
    ])
    .signers([admin])
    .rpc();

  console.log(`[oracle-settle] settle_market succeeded (tx: ${settleSig})`);

  // Best-effort rent recovery - failure here does not affect settlement outcome.
  if (closeInstructions.length > 0) {
    try {
      await sendInstructionsSequentially(connection, admin, closeInstructions);
      console.log(`[oracle-settle] Price update accounts closed (rent recovered)`);
    } catch (closeErr) {
      console.warn(
        `[oracle-settle] Failed to close price update accounts (non-fatal): ${closeErr}`
      );
    }
  }

  return settleSig;
}
