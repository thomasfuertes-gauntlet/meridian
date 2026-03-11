import { PublicKey } from "@solana/web3.js";

export interface DeskWallet {
  id: string;
  label: string;
  publicKey: PublicKey;
  shortLabel: string;
}

export const DEV_DESKS: DeskWallet[] = [
  {
    id: "admin",
    label: "Admin desk",
    shortLabel: "Admin",
    publicKey: new PublicKey("5Ux797xeoqotK8b6qtjYWwfS2fv7p9ZLV9V2ZAcxiyo"),
  },
  {
    id: "bot-a",
    label: "Bot A market maker",
    shortLabel: "Bot A",
    publicKey: new PublicKey("48xYES8qxE1vvHPVJKJCdKRhDMbueeWmJhGHKQ3gWGhh"),
  },
  {
    id: "bot-b",
    label: "Bot B frontend/strategy",
    shortLabel: "Bot B",
    publicKey: new PublicKey("RSG4qia3Dp9pGPzsMnFS9AzsRPKyJxJ75iyoSubwQ5W"),
  },
];

export function getDeskWallets(
  connectedWallet: PublicKey | null | undefined
): DeskWallet[] {
  const options = [...DEV_DESKS];

  if (!connectedWallet) {
    return options;
  }

  const existing = options.find((entry) => entry.publicKey.equals(connectedWallet));
  if (existing) {
    return options.map((entry) =>
      entry.publicKey.equals(connectedWallet)
        ? { ...entry, label: `Connected wallet (${entry.label})` }
        : entry
    );
  }

  return [
    {
      id: "connected",
      label: "Connected wallet",
      shortLabel: "Connected",
      publicKey: connectedWallet,
    },
    ...options,
  ];
}

export function deskLabelForPubkey(
  pubkey: string | null,
  deskWallets: DeskWallet[]
): string | null {
  if (!pubkey) return null;
  return deskWallets.find((entry) => entry.publicKey.toBase58() === pubkey)?.shortLabel ?? null;
}
