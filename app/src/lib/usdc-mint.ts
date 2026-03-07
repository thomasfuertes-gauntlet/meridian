import { PublicKey } from "@solana/web3.js";

// Env var takes priority (Railway/devnet). Falls back to local-config.json (local dev).
// local-config.json is gitignored - dynamic import so tsc doesn't fail when it's absent.
let mintAddress: string | null =
  (import.meta.env.VITE_USDC_MINT as string | undefined) || null;

if (!mintAddress) {
  try {
    // @ts-ignore - file may not exist on Railway, caught below
    const config = await import("./local-config.json");
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
