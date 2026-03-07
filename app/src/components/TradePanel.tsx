import { useState, useCallback, useEffect } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getProgram } from "../lib/anchor";
import {
  buildBuyYesTx,
  buildBuyNoTx,
  buildSellYesTx,
  buildSellNoTx,
} from "../lib/trade";
import { getPositionConflict } from "../lib/portfolio";
import { USDC_PER_PAIR } from "../lib/constants";

type TradeAction = "buyYes" | "buyNo" | "sellYes" | "sellNo";

interface TradePanelProps {
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcMint: PublicKey;
  strikePrice: number;
  ticker: string;
  bestBid: number | null;
  bestAsk: number | null;
}

const ACTION_LABELS: Record<TradeAction, string> = {
  buyYes: "Buy Yes",
  buyNo: "Buy No",
  sellYes: "Sell Yes",
  sellNo: "Sell No",
};

const ACTION_COLORS: Record<TradeAction, string> = {
  buyYes: "bg-green-600 hover:bg-green-500",
  buyNo: "bg-red-600 hover:bg-red-500",
  sellYes: "bg-red-600 hover:bg-red-500",
  sellNo: "bg-green-600 hover:bg-green-500",
};

export function TradePanel({
  market,
  yesMint,
  noMint,
  usdcMint,
  strikePrice,
  ticker,
  bestBid,
  bestAsk,
}: TradePanelProps) {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const [action, setAction] = useState<TradeAction>("buyYes");
  const [quantity, setQuantity] = useState("100");
  const [price, setPrice] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [balanceMap, setBalanceMap] = useState<Map<string, number>>(new Map());

  // Fetch user token balances for position constraint checking
  useEffect(() => {
    if (!wallet) return;
    async function loadBalances() {
      const accounts = await connection.getTokenAccountsByOwner(
        wallet!.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );
      const map = new Map<string, number>();
      for (const { account } of accounts.value) {
        const mint = new PublicKey(account.data.subarray(0, 32));
        const amount = Number(account.data.readBigUInt64LE(64));
        if (amount > 0) map.set(mint.toString(), amount);
      }
      setBalanceMap(map);
    }
    loadBalances();
  }, [wallet, connection, market]);

  const conflict = wallet
    ? getPositionConflict(balanceMap, yesMint, noMint, action)
    : null;

  const effectivePrice = price
    ? Math.round(parseFloat(price) * USDC_PER_PAIR)
    : action === "buyYes" || action === "sellNo"
      ? bestAsk
      : bestBid;

  const payoff =
    effectivePrice != null
      ? action === "buyYes" || action === "sellNo"
        ? USDC_PER_PAIR - effectivePrice
        : effectivePrice
      : null;

  const handleTrade = useCallback(async () => {
    if (!wallet || effectivePrice == null) return;

    setStatus("Building transaction...");
    try {
      const program = getProgram(wallet);
      const params = {
        program,
        user: wallet.publicKey,
        market,
        yesMint,
        noMint,
        usdcMint,
        price: new BN(effectivePrice),
        quantity: new BN(parseInt(quantity) || 1),
      };

      const builders: Record<TradeAction, typeof buildBuyYesTx> = {
        buyYes: buildBuyYesTx,
        buyNo: buildBuyNoTx,
        sellYes: buildSellYesTx,
        sellNo: buildSellNoTx,
      };

      const tx = await builders[action](params);
      setStatus("Awaiting signature...");

      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      const signed = await wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");

      setStatus(`Confirmed: ${sig.slice(0, 8)}...`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Error: ${msg.slice(0, 100)}`);
    }
  }, [
    wallet,
    connection,
    action,
    quantity,
    effectivePrice,
    market,
    yesMint,
    noMint,
    usdcMint,
  ]);

  const strikeDollars = (strikePrice / USDC_PER_PAIR).toFixed(2);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-bold text-gray-300 mb-3">Trade</h3>

      {/* Action selector */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        {(Object.keys(ACTION_LABELS) as TradeAction[]).map((a) => (
          <button
            key={a}
            onClick={() => setAction(a)}
            className={`text-sm py-1.5 rounded font-medium transition-colors ${
              action === a
                ? ACTION_COLORS[a] + " text-white"
                : "bg-gray-800 text-gray-400 hover:text-gray-200"
            }`}
          >
            {ACTION_LABELS[a]}
          </button>
        ))}
      </div>

      {/* Price input */}
      <div className="mb-3">
        <label className="text-xs text-gray-500 block mb-1">
          Price (USDC) - leave empty for market
        </label>
        <input
          type="number"
          step="0.01"
          min="0.01"
          max="0.99"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder={
            effectivePrice != null
              ? (effectivePrice / USDC_PER_PAIR).toFixed(2)
              : "0.50"
          }
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
        />
      </div>

      {/* Quantity input */}
      <div className="mb-4">
        <label className="text-xs text-gray-500 block mb-1">
          Quantity (contracts)
        </label>
        <input
          type="number"
          min="1"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
        />
      </div>

      {/* Payoff display */}
      {effectivePrice != null && (
        <div className="bg-gray-800/50 rounded p-3 mb-4 text-xs text-gray-400">
          <p>
            You pay{" "}
            <span className="text-white">
              ${((effectivePrice / USDC_PER_PAIR) * parseInt(quantity || "1")).toFixed(2)}
            </span>{" "}
            USDC
          </p>
          <p>
            You win{" "}
            <span className="text-green-400">
              ${(parseInt(quantity || "1")).toFixed(2)}
            </span>{" "}
            if {ticker} closes{" "}
            {action === "buyYes" || action === "sellNo" ? "above" : "below"}{" "}
            ${strikeDollars}
          </p>
          {payoff != null && (
            <p>
              Max profit:{" "}
              <span className="text-green-400">
                ${((payoff / USDC_PER_PAIR) * parseInt(quantity || "1")).toFixed(2)}
              </span>
            </p>
          )}
        </div>
      )}

      {/* Position constraint warning */}
      {conflict && (
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded p-3 mb-4 text-xs text-yellow-400">
          {conflict}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleTrade}
        disabled={!wallet || effectivePrice == null || !!conflict}
        className={`w-full py-2.5 rounded font-medium text-sm transition-colors ${
          !wallet || !!conflict
            ? "bg-gray-800 text-gray-500 cursor-not-allowed"
            : ACTION_COLORS[action] + " text-white"
        }`}
      >
        {!wallet
          ? "Connect wallet"
          : conflict
            ? "Position conflict"
            : ACTION_LABELS[action]}
      </button>

      {status && (
        <p className="mt-2 text-xs text-gray-400 break-all">{status}</p>
      )}
    </div>
  );
}
