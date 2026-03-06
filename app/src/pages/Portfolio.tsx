import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getProgram } from "../lib/anchor";
import {
  fetchPositions,
  buildRedeemTx,
  buildBurnPairTx,
  type Position,
} from "../lib/portfolio";
import { USDC_PER_PAIR } from "../lib/constants";

// Placeholder - should come from deployment config
const DEVNET_USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

function OutcomeBadge({ outcome }: { outcome: Position["outcome"] }) {
  if (outcome === "pending")
    return <span className="text-yellow-400 text-xs">Active</span>;
  if (outcome === "yesWins")
    return <span className="text-green-400 text-xs">Yes Wins</span>;
  return <span className="text-red-400 text-xs">No Wins</span>;
}

export function Portfolio() {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const loadPositions = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    try {
      const program = getProgram(wallet);
      const pos = await fetchPositions(program, connection, wallet.publicKey);
      setPositions(pos);
    } catch (err) {
      console.error("Failed to load positions:", err);
    } finally {
      setLoading(false);
    }
  }, [wallet, connection]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  const handleRedeem = useCallback(
    async (pos: Position, side: "yes" | "no") => {
      if (!wallet) return;
      setStatus("Building redeem TX...");
      try {
        const program = getProgram(wallet);
        const tokenMint = side === "yes" ? pos.yesMint : pos.noMint;
        const amount = side === "yes" ? pos.yesBalance : pos.noBalance;

        const tx = await buildRedeemTx(
          program,
          wallet.publicKey,
          pos.market,
          tokenMint,
          DEVNET_USDC_MINT,
          amount
        );

        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        const signed = await wallet.signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");

        setStatus(`Redeemed! ${sig.slice(0, 8)}...`);
        loadPositions();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`Error: ${msg.slice(0, 100)}`);
      }
    },
    [wallet, connection, loadPositions]
  );

  const handleBurnPair = useCallback(
    async (pos: Position) => {
      if (!wallet) return;
      const amount = Math.min(pos.yesBalance, pos.noBalance);
      if (amount === 0) return;
      setStatus("Building burn_pair TX...");
      try {
        const program = getProgram(wallet);
        const tx = await buildBurnPairTx(
          program,
          wallet.publicKey,
          pos.market,
          pos.yesMint,
          pos.noMint,
          DEVNET_USDC_MINT,
          amount
        );

        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        const signed = await wallet.signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");

        setStatus(`Burned ${amount} pair(s)! ${sig.slice(0, 8)}...`);
        loadPositions();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`Error: ${msg.slice(0, 100)}`);
      }
    },
    [wallet, connection, loadPositions]
  );

  if (!wallet) {
    return (
      <div className="text-center py-20 text-gray-500">
        Connect your wallet to view positions
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Portfolio</h1>
        <button
          onClick={loadPositions}
          disabled={loading}
          className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded px-3 py-1"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {positions.length === 0 ? (
        <div className="text-center py-12 text-gray-600">
          {loading ? "Loading positions..." : "No positions found"}
        </div>
      ) : (
        <div className="space-y-3">
          {positions.map((pos) => {
            const strikeDollars = (pos.strikePrice / USDC_PER_PAIR).toFixed(2);
            const isYesWinner =
              pos.settled && pos.outcome === "yesWins";
            const isNoWinner =
              pos.settled && pos.outcome === "noWins";
            const canBurnPair =
              !pos.settled &&
              pos.yesBalance > 0 &&
              pos.noBalance > 0;

            return (
              <div
                key={pos.market.toString()}
                className="bg-gray-900 border border-gray-800 rounded-lg p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-white">{pos.ticker}</span>
                    <span className="text-gray-400 font-mono text-sm">
                      &gt; ${strikeDollars}
                    </span>
                    <OutcomeBadge outcome={pos.outcome} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  {/* Yes tokens */}
                  {pos.yesBalance > 0 && (
                    <div className="flex items-center justify-between bg-gray-800/50 rounded px-3 py-2">
                      <div>
                        <span className="text-green-400">Yes</span>
                        <span className="text-gray-400 ml-2">
                          x{pos.yesBalance}
                        </span>
                      </div>
                      {pos.settled && isYesWinner && (
                        <button
                          onClick={() => handleRedeem(pos, "yes")}
                          className="bg-green-600 hover:bg-green-500 text-white text-xs px-3 py-1 rounded"
                        >
                          Redeem ${pos.yesBalance.toFixed(2)}
                        </button>
                      )}
                      {pos.settled && !isYesWinner && (
                        <span className="text-gray-600 text-xs">
                          $0.00
                        </span>
                      )}
                    </div>
                  )}

                  {/* No tokens */}
                  {pos.noBalance > 0 && (
                    <div className="flex items-center justify-between bg-gray-800/50 rounded px-3 py-2">
                      <div>
                        <span className="text-red-400">No</span>
                        <span className="text-gray-400 ml-2">
                          x{pos.noBalance}
                        </span>
                      </div>
                      {pos.settled && isNoWinner && (
                        <button
                          onClick={() => handleRedeem(pos, "no")}
                          className="bg-green-600 hover:bg-green-500 text-white text-xs px-3 py-1 rounded"
                        >
                          Redeem ${pos.noBalance.toFixed(2)}
                        </button>
                      )}
                      {pos.settled && !isNoWinner && (
                        <span className="text-gray-600 text-xs">
                          $0.00
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Burn pair option */}
                {canBurnPair && (
                  <button
                    onClick={() => handleBurnPair(pos)}
                    className="mt-3 w-full text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded py-1.5 transition-colors"
                  >
                    Burn {Math.min(pos.yesBalance, pos.noBalance)} pair(s) for
                    ${Math.min(pos.yesBalance, pos.noBalance).toFixed(2)} USDC
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {status && (
        <p className="mt-4 text-xs text-gray-400 break-all">{status}</p>
      )}
    </div>
  );
}
