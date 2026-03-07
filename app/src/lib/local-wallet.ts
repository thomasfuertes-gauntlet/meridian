/**
 * Auto-sign wallet adapter for localhost development.
 * Uses the deterministic bot-b keypair so users can trade without Phantom.
 * Only active when RPC_URL points to localhost.
 */
import { createHash } from "crypto";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { BaseSignerWalletAdapter, WalletReadyState } from "@solana/wallet-adapter-base";
import type { WalletName } from "@solana/wallet-adapter-base";

// Same derivation as scripts/dev-wallets.ts
function deriveKeypair(name: string): Keypair {
  const seed = createHash("sha256").update(`meridian-dev-${name}`).digest();
  return Keypair.fromSeed(seed);
}

const DEV_KEYPAIR = deriveKeypair("bot-b");

export class LocalDevWalletAdapter extends BaseSignerWalletAdapter {
  name = "Dev Wallet" as WalletName;
  url = "https://localhost";
  icon = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI4IiBmaWxsPSIjNGFkZTgwIi8+PHRleHQgeD0iMTYiIHk9IjIyIiBmb250LXNpemU9IjE4IiBmb250LWZhbWlseT0ibW9ub3NwYWNlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjMDAwIj5EPC90ZXh0Pjwvc3ZnPg==" as string;
  readyState = WalletReadyState.Installed;
  connecting = false;
  supportedTransactionVersions = new Set(["legacy", 0] as const);

  private _connected = false;
  private _publicKey: PublicKey = DEV_KEYPAIR.publicKey;

  get publicKey(): PublicKey {
    return this._publicKey;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    this._connected = true;
    this.emit("connect", this._publicKey);
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof Transaction) {
      tx.partialSign(DEV_KEYPAIR);
    } else {
      tx.sign([DEV_KEYPAIR]);
    }
    return tx;
  }
}
