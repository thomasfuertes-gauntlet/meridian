import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConfiguredUsdcMint } from "../lib/usdc-mint";
import { USDC_PER_PAIR } from "../lib/constants";

const POLL_MS = 10_000;

export function WalletButton() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [balance, setBalance] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    const usdcMint = getConfiguredUsdcMint();
    if (!publicKey || !usdcMint) {
      setBalance(null);
      return;
    }

    const ata = getAssociatedTokenAddressSync(usdcMint, publicKey, false, TOKEN_PROGRAM_ID);

    async function fetch() {
      try {
        const info = await connection.getTokenAccountBalance(ata);
        const raw = Number(info.value.amount);
        setBalance(raw / USDC_PER_PAIR);
      } catch {
        // No ATA yet - wallet has no USDC
        setBalance(null);
      }
    }

    fetch();
    timerRef.current = setInterval(fetch, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [connection, publicKey]);

  return (
    <>
      {balance != null && (
        <span data-usdc-balance>
          ${balance.toFixed(2)}
        </span>
      )}
      <WalletMultiButton />
    </>
  );
}
