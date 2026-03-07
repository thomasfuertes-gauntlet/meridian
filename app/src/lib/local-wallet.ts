/**
 * Auto-sign wallet adapter for dev environments.
 * Uses the deterministic bot-b keypair so users can trade without Phantom.
 * Active on localhost or when VITE_DEV_WALLET=true (e.g. Railway demo).
 */
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { BaseSignerWalletAdapter, WalletReadyState } from "@solana/wallet-adapter-base";
import type { WalletName } from "@solana/wallet-adapter-base";

// Pre-computed sha256("meridian-dev-bot-b") - avoids Node crypto import in browser
const BOT_B_SEED = new Uint8Array([216,203,1,24,131,66,29,212,48,8,128,132,145,120,92,100,20,242,44,6,35,255,181,187,199,94,79,179,255,200,118,232]);
const DEV_KEYPAIR = Keypair.fromSeed(BOT_B_SEED);

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
