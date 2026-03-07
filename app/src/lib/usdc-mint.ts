import { PublicKey } from "@solana/web3.js";

// Env var takes priority (Railway/devnet). Falls back to local-config.json (local dev).
// local-config.json is gitignored - only exists after `make setup`.
// Dynamic path variable prevents Rollup from resolving at build time.
let mintAddress: string | null =
  (import.meta.env.VITE_USDC_MINT as string | undefined) || null;

if (!mintAddress) {
  try {
    const configPath = "./local-config" + ".json";
    const config = await import(/* @vite-ignore */ configPath);
    mintAddress = config.usdcMint ?? config.default?.usdcMint ?? null;
  } catch {
    // No local config - expected on devnet/Railway
  }
}

export function useUsdcMint(): PublicKey {
  if (!mintAddress) {
    throw new Error(
      "USDC mint not configured. Run `make setup` or set VITE_USDC_MINT."
    );
  }
  return new PublicKey(mintAddress);
}
