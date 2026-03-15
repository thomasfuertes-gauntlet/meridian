/**
 * Devnet-only USDC faucet button. Admin keypair (mint authority) signs and
 * pays for the transaction - user just needs to be connected for their pubkey.
 * Only renders on remote RPC (IS_REMOTE_RPC) when USDC mint is configured.
 */
import { useState } from "react";
import { Keypair, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { IS_REMOTE_RPC } from "../lib/constants";
import { getConfiguredUsdcMint } from "../lib/usdc-mint";

// Deterministic default: sha256("meridian-dev-admin")
// Admin is the USDC mint authority and pays the faucet tx fee.
const DEFAULT_ADMIN_SEED = new Uint8Array([
  40, 100, 210, 154, 86, 62, 31, 103, 52, 81, 136, 199, 204, 204, 11, 86, 90,
  55, 146, 76, 143, 64, 228, 47, 38, 106, 116, 12, 98, 94, 24, 252,
]);

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const ADMIN_SEED = import.meta.env.VITE_ADMIN_SEED
  ? hexToBytes(import.meta.env.VITE_ADMIN_SEED)
  : DEFAULT_ADMIN_SEED;
const ADMIN_KEYPAIR = Keypair.fromSeed(ADMIN_SEED);

// 100 USDC in base units (6 decimals)
const FAUCET_AMOUNT = BigInt(100 * 1_000_000);

export function FaucetButton() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const usdcMint = getConfiguredUsdcMint();

  if (!IS_REMOTE_RPC || !usdcMint || !publicKey) return null;

  const handleFaucet = async () => {
    setLoading(true);
    setStatus("Building transaction...");
    try {
      const userUsdc = getAssociatedTokenAddressSync(usdcMint, publicKey);

      const tx = new Transaction();
      tx.feePayer = ADMIN_KEYPAIR.publicKey;

      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          ADMIN_KEYPAIR.publicKey,
          userUsdc,
          publicKey,
          usdcMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );

      tx.add(
        createMintToInstruction(
          usdcMint,
          userUsdc,
          ADMIN_KEYPAIR.publicKey,
          FAUCET_AMOUNT
        )
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.sign(ADMIN_KEYPAIR);

      setStatus("Sending...");
      const signature = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      setStatus(`Minted $100 USDC (${signature.slice(0, 8)}...)`);
    } catch (err) {
      setStatus(
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button onClick={() => void handleFaucet()} disabled={loading}>
        {loading ? "Minting..." : "Get Test USDC"}
      </button>
      {status && <small>{status}</small>}
    </>
  );
}
