import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { type AnchorWallet } from "@solana/wallet-adapter-react";
import { IS_REMOTE_RPC, RPC_URL } from "./constants";
import idl from "../idl/meridian.json";

// Remote RPCs require explicit wsEndpoint (http->ws). Local validator auto-derives port+1.
const wsEndpoint = IS_REMOTE_RPC ? RPC_URL.replace(/^http/, "ws") : undefined;
const rawConnection = new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint });

// Debug proxy: logs all RPC method calls to console when ?debug=rpc is in URL
const debugRpc = new URLSearchParams(window.location.search).has("debug");
let wsSubCount = 0;
const WS_SUB_METHODS = new Set(["onLogs", "onAccountChange", "onProgramAccountChange"]);
const WS_UNSUB_METHODS = new Set(["removeOnLogsListener", "removeAccountChangeListener", "removeProgramAccountChangeListener"]);
export const connection: Connection = debugRpc
  ? new Proxy(rawConnection, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === "function") {
          if (WS_SUB_METHODS.has(String(prop))) {
            return (...args: unknown[]) => {
              const result = val.apply(target, args);
              wsSubCount++;
              console.debug(`[ws-budget] ${wsSubCount} active WS subs`);
              if (wsSubCount > 5) {
                console.warn(`[ws-budget] ${wsSubCount} active WS subs - exceeds Helius free-tier limit of 5`);
              }
              return result;
            };
          }
          if (WS_UNSUB_METHODS.has(String(prop))) {
            return (...args: unknown[]) => {
              const result = val.apply(target, args);
              wsSubCount = Math.max(0, wsSubCount - 1);
              console.debug(`[ws-budget] ${wsSubCount} active WS subs`);
              return result;
            };
          }
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
