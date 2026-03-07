import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { type AnchorWallet } from "@solana/wallet-adapter-react";
import { RPC_URL } from "./constants";
import idl from "../idl/meridian.json";

const rawConnection = new Connection(RPC_URL, "confirmed");

// Debug proxy: logs all RPC method calls to console when ?debug=rpc is in URL
const debugRpc = new URLSearchParams(window.location.search).has("debug");
export const connection: Connection = debugRpc
  ? new Proxy(rawConnection, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === "function") {
          return (...args: unknown[]) => {
            const result = val.apply(target, args);
            if (result instanceof Promise) {
              console.debug(`[rpc] ${String(prop)}`, args.length > 0 ? args[0] : "");
            }
            return result;
          };
        }
        return val;
      },
    })
  : rawConnection;

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
