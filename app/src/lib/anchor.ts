import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { type AnchorWallet } from "@solana/wallet-adapter-react";
import { RPC_URL } from "./constants";
import idl from "../idl/meridian.json";

export const connection = new Connection(RPC_URL, "confirmed");

export function getProvider(wallet: AnchorWallet): AnchorProvider {
  return new AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
}

export function getProgram(wallet: AnchorWallet): Program {
  const provider = getProvider(wallet);
  return new Program(idl as Idl, provider);
}

/** Read-only program instance (no wallet needed for account fetches) */
export function getReadOnlyProgram(): Program {
  const provider = new AnchorProvider(connection, {} as AnchorWallet, {
    preflightCommitment: "confirmed",
  });
  return new Program(idl as Idl, provider);
}
