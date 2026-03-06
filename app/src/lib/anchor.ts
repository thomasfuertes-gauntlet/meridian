import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { type AnchorWallet } from "@solana/wallet-adapter-react";
import { DEVNET_RPC } from "./constants";
import idl from "../idl/meridian.json";

export const connection = new Connection(DEVNET_RPC, "confirmed");

export function getProvider(wallet: AnchorWallet): AnchorProvider {
  return new AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
}

export function getProgram(wallet: AnchorWallet): Program {
  const provider = getProvider(wallet);
  return new Program(idl as Idl, provider);
}
