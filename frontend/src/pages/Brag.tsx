import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import {
  loadTree,
  findLeaf,
  generateBragProof,
  encodeProofUrl,
  type TreeData,
  type LeafData,
} from "../lib/zkp";

type Stage = "loading" | "no-tree" | "not-found" | "ready" | "proving" | "done";

export function Brag() {
  const wallet = useAnchorWallet();
  const [stage, setStage] = useState<Stage>("loading");
  const [tree, setTree] = useState<TreeData | null>(null);
  const [leaf, setLeaf] = useState<LeafData | null>(null);
  const [claimedMin, setClaimedMin] = useState(1);
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;

    (async () => {
      try {
        const t = await loadTree();
        if (cancelled) return;
        setTree(t);
        const idx = findLeaf(t, wallet.publicKey);
        if (idx === -1) {
          setStage("not-found");
          return;
        }
        const l = t.leaves[idx];
        setLeaf(l);
        setClaimedMin(l.wins);
        setStage("ready");
      } catch {
        if (!cancelled) setStage("no-tree");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const handleGenerate = useCallback(async () => {
    if (!wallet || !tree || !leaf) return;
    setStage("proving");
    setError(null);
    try {
      const { proof, publicSignals } = await generateBragProof(
        wallet.publicKey,
        claimedMin,
        tree
      );
      const encoded = encodeProofUrl(proof, publicSignals, {
        timestamp: tree.timestamp,
        marketCount: tree.marketCount,
      });
      setProofUrl(`${window.location.origin}/verify#${encoded}`);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("ready");
    }
  }, [wallet, tree, leaf, claimedMin]);

  const handleCopy = useCallback(() => {
    if (!proofUrl) return;
    navigator.clipboard.writeText(proofUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [proofUrl]);

  if (!wallet) {
    return (
      <div className="text-center py-20 text-gray-500">
        Connect your wallet to generate ZK proofs
      </div>
    );
  }

  if (stage === "loading") {
    return (
      <div className="text-center py-20 text-gray-500">Loading tree data...</div>
    );
  }

  if (stage === "no-tree") {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500">
          No tree data found. Run <code className="text-green-400">make tree</code>{" "}
          after markets settle.
        </p>
      </div>
    );
  }

  if (stage === "not-found") {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500">
          Your wallet has no settled positions in the current tree.
        </p>
        <p className="text-gray-600 text-sm mt-2">
          Trade in active markets, wait for settlement, then run{" "}
          <code className="text-green-400">make tree</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-white mb-6">ZK Brag</h1>

      {/* Stats card */}
      {leaf && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 mb-6">
          <h2 className="text-sm text-gray-400 mb-3">Your Trading Record</h2>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold text-green-400">{leaf.wins}</div>
              <div className="text-xs text-gray-500">Wins</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{leaf.total}</div>
              <div className="text-xs text-gray-500">Total</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-yellow-400">
                {((leaf.wins / leaf.total) * 100).toFixed(0)}%
              </div>
              <div className="text-xs text-gray-500">Win Rate</div>
            </div>
          </div>
        </div>
      )}

      {/* Claim threshold */}
      {stage === "ready" && leaf && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 mb-6">
          <label className="block text-sm text-gray-400 mb-2">
            Claim: "I won at least N markets"
          </label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={1}
              max={leaf.wins}
              value={claimedMin}
              onChange={(e) => setClaimedMin(Number(e.target.value))}
              className="flex-1 accent-green-400"
            />
            <span className="text-xl font-bold text-green-400 w-10 text-right">
              {claimedMin}
            </span>
          </div>
          <p className="text-xs text-gray-600 mt-2">
            Lower threshold reveals less about your exact record.
          </p>

          <button
            onClick={handleGenerate}
            className="mt-4 w-full bg-green-600 hover:bg-green-500 text-white font-medium py-2 rounded transition-colors"
          >
            Generate ZK Proof
          </button>

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        </div>
      )}

      {/* Proving spinner */}
      {stage === "proving" && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
          <div className="animate-spin text-3xl mb-3">&#x2699;</div>
          <p className="text-gray-400">Generating Groth16 proof...</p>
          <p className="text-xs text-gray-600 mt-1">This takes ~5-10 seconds</p>
        </div>
      )}

      {/* Proof result card */}
      {stage === "done" && proofUrl && (
        <div className="bg-gray-900 border-2 border-green-500 rounded-lg p-6">
          <div className="text-center mb-4">
            <div className="text-4xl mb-2">&#x1F6E1;</div>
            <h2 className="text-lg font-bold text-green-400">
              ZK Proof Generated
            </h2>
            <p className="text-sm text-gray-400 mt-1">
              Verified: won at least {claimedMin} market
              {claimedMin > 1 ? "s" : ""}
            </p>
          </div>

          <div className="bg-gray-800 rounded p-3 mb-4">
            <p className="text-xs text-gray-500 break-all font-mono">
              {proofUrl.slice(0, 80)}...
            </p>
          </div>

          <button
            onClick={handleCopy}
            className="w-full bg-gray-800 hover:bg-gray-700 text-white py-2 rounded transition-colors text-sm"
          >
            {copied ? "Copied!" : "Copy Shareable Link"}
          </button>

          <p className="text-xs text-gray-600 text-center mt-3">
            Anyone can verify this proof without knowing your wallet.
          </p>
        </div>
      )}
    </div>
  );
}
