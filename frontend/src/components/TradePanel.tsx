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
  const [balanceTick, setBalanceTick] = useState(0);

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
  }, [wallet, connection, market, balanceTick]);

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
      setBalanceTick((t) => t + 1);
    } catch (err: unknown) {
      console.error("Trade failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Error: ${msg.slice(0, 200)}`);
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
    <form onSubmit={(e) => { e.preventDefault(); void handleTrade(); }}>
      <h3>Order entry</h3>

      <nav>
        {(Object.keys(ACTION_LABELS) as TradeAction[]).map((a) => (
          <button
            key={a}
            type="button"
            data-active={action === a ? "true" : undefined}
            onClick={() => setAction(a)}
          >
            {ACTION_LABELS[a]}
          </button>
        ))}
      </nav>

      <label>
        Price (USDC) - leave empty for market
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
        />
      </label>

      <label>
        Quantity (contracts)
        <input
          type="number"
          min="1"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </label>

      {effectivePrice != null && (
        <output>
          You pay ${((effectivePrice / USDC_PER_PAIR) * parseInt(quantity || "1")).toFixed(2)} USDC.{" "}
          You win <mark data-tone="green">${(parseInt(quantity || "1")).toFixed(2)}</mark> if {ticker} closes{" "}
          {action === "buyYes" || action === "sellNo" ? "above" : "below"} ${strikeDollars}.
          {payoff != null && (
            <> Max profit: <mark data-tone="green">${((payoff / USDC_PER_PAIR) * parseInt(quantity || "1")).toFixed(2)}</mark></>
          )}
        </output>
      )}

      {conflict && (
        <p><mark data-tone="blue">{conflict}</mark></p>
      )}

      <button
        type="submit"
        disabled={!wallet || effectivePrice == null || !!conflict}
      >
        {!wallet
          ? "Connect wallet"
          : conflict
            ? "Position conflict"
            : ACTION_LABELS[action]}
      </button>

      {status && <small>{status}</small>}
    </form>
  );
}
