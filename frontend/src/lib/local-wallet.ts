/**
 * Auto-sign wallet adapter for dev environments.
 * Uses a dedicated "user" keypair - separate from bot wallets so the
 * UI portfolio is clean of bot activity.
 * Active on localhost or when VITE_DEV_WALLET=true (e.g. Railway demo).
 */
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { BaseSignerWalletAdapter, WalletReadyState } from "@solana/wallet-adapter-base";
import type { WalletName } from "@solana/wallet-adapter-base";

// Deterministic default: sha256("meridian-dev-user"), pre-computed for browser.
// Override via VITE_USER_SEED (hex) when WALLET_MODE=generate.
const DEFAULT_USER_SEED = new Uint8Array([227,241,45,217,52,146,183,221,180,88,4,122,179,76,79,200,232,126,89,99,38,56,148,38,213,237,27,212,134,63,49,183]);

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const USER_SEED = import.meta.env.VITE_USER_SEED
  ? hexToBytes(import.meta.env.VITE_USER_SEED)
  : DEFAULT_USER_SEED;
const DEV_KEYPAIR = Keypair.fromSeed(USER_SEED);

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
