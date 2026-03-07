import { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { decodeProofUrl, verifyBragProof, type ProofUrlData } from "../lib/zkp";

type Status = "parsing" | "verifying" | "valid" | "invalid" | "error";

export function Verify() {
  const { hash } = useLocation();
  const [status, setStatus] = useState<Status>("parsing");
  const [data, setData] = useState<ProofUrlData | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!hash || hash === "#") {
      setStatus("error");
      setErrorMsg("No proof provided. Get a proof link from the Brag page.");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const decoded = decodeProofUrl(hash);
        if (cancelled) return;
        setData(decoded);
        setStatus("verifying");

        const valid = await verifyBragProof(decoded.proof, decoded.publicSignals);
        if (cancelled) return;
        setStatus(valid ? "valid" : "invalid");
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(err instanceof Error ? err.message : "Failed to parse proof");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hash]);

  // Extract claimed min wins from public signals [root, claimedMinWins]
  const claimedMinWins = data?.publicSignals?.[1]
    ? Number(data.publicSignals[1])
    : null;

  if (status === "parsing" || status === "verifying") {
    return (
      <div className="max-w-lg mx-auto text-center py-20">
        <div className="animate-spin text-3xl mb-3">&#x2699;</div>
        <p className="text-gray-400">
          {status === "parsing" ? "Parsing proof..." : "Verifying ZK proof..."}
        </p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="max-w-lg mx-auto text-center py-20">
        <div className="text-4xl mb-3">&#x26A0;</div>
        <p className="text-gray-400">{errorMsg}</p>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="max-w-lg mx-auto py-12">
        <div className="bg-gray-900 border-2 border-red-500 rounded-lg p-6 text-center">
          <div className="text-4xl mb-2">&#x2716;</div>
          <h2 className="text-lg font-bold text-red-400">Invalid Proof</h2>
          <p className="text-sm text-gray-400 mt-2">
            This proof could not be verified. It may have been tampered with.
          </p>
        </div>
      </div>
    );
  }

  // Valid
  const timestamp = data?.metadata?.timestamp
    ? new Date(data.metadata.timestamp).toLocaleDateString()
    : "Unknown";

  return (
    <div className="max-w-lg mx-auto py-12">
      <div className="bg-gray-900 border-2 border-green-500 rounded-lg p-6 text-center">
        <div className="text-4xl mb-2">&#x2705;</div>
        <h2 className="text-lg font-bold text-green-400">Verified ZK Proof</h2>
        <p className="text-sm text-gray-300 mt-3">
          Someone correctly predicted at least{" "}
          <span className="text-green-400 font-bold">{claimedMinWins}</span> market
          {claimedMinWins !== 1 ? "s" : ""} on Meridian.
        </p>

        <div className="mt-4 bg-gray-800 rounded p-3 text-xs text-gray-500">
          <div className="flex justify-between">
            <span>Tree snapshot</span>
            <span>{timestamp}</span>
          </div>
          <div className="flex justify-between mt-1">
            <span>Markets in tree</span>
            <span>{data?.metadata?.marketCount ?? "?"}</span>
          </div>
        </div>

        <p className="text-xs text-gray-600 mt-4">
          Zero-knowledge proof - the prover's wallet address is not revealed.
        </p>
      </div>
    </div>
  );
}
