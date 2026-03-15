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
  buildPlaceOrderTx,
  buildBuyNoLimitTx,
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

// Map on-chain error messages to user-friendly descriptions
const ERROR_MAP: [RegExp, string][] = [
  [/AtomicTradeIncomplete/, "Not enough liquidity to fill your order. Try a smaller quantity."],
  [/insufficient funds/, "Insufficient token balance for this trade."],
  [/OrderBookFull/, "Order book is full (32 orders/side). Try again after cancellations."],
  [/NoMatchingOrders/, "No orders on the book to match against."],
  [/MarketFrozen/, "Market is frozen for settlement. Trading resumes next cycle."],
  [/MarketAlreadySettled/, "This market has already settled. Check portfolio to redeem."],
  [/InvalidPrice/, "Price must be between $0.01 and $0.99."],
  [/Paused/, "Protocol is paused by admin."],
  [/CreditLedgerFull/, "Credit ledger full (64 unique makers). Claim fills first."],
  [/CrossingOrdersUseDedicatedPath/, "Limit price crosses the book. Use market order or adjust price."],
  [/User rejected/, "Transaction cancelled."],
];

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [pattern, friendly] of ERROR_MAP) {
    if (pattern.test(raw)) return friendly;
  }
  return raw.slice(0, 150);
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
  const emptyBook = bestBid == null && bestAsk == null;
  const [price, setPrice] = useState(emptyBook ? "0.50" : "");
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

  const isLimit = price !== "";
  const priceUsdc = isLimit ? Math.round(parseFloat(price) * USDC_PER_PAIR) : null;

  const effectivePrice = isLimit
    ? priceUsdc
    : action === "buyYes" || action === "sellNo"
      ? bestAsk
      : bestBid;

  // Does a limit price cross the opposite side of the book?
  const wouldCross =
    isLimit &&
    priceUsdc != null &&
    (action === "buyYes" || action === "sellNo"
      ? bestAsk != null && priceUsdc >= bestAsk
      : bestBid != null && priceUsdc <= bestBid);

  const isResting = isLimit && !wouldCross;

  // Sell No limit can't be atomic (bid + redeem requires async fill)
  const sellNoLimitBlocked = action === "sellNo" && isResting;

  const handleTrade = useCallback(async () => {
    if (!wallet || effectivePrice == null || sellNoLimitBlocked) return;

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

      let tx;
      if (isResting) {
        // Maker path: resting limit order
        switch (action) {
          case "buyYes":
            tx = await buildPlaceOrderTx(params, "bid");
            break;
          case "sellYes":
            tx = await buildPlaceOrderTx(params, "ask");
            break;
          case "buyNo":
            tx = await buildBuyNoLimitTx(params);
            break;
          default:
            return; // sellNo limit blocked above
        }
      } else {
        // Taker path: cross the book
        const builders: Record<TradeAction, typeof buildBuyYesTx> = {
          buyYes: buildBuyYesTx,
          buyNo: buildBuyNoTx,
          sellYes: buildSellYesTx,
          sellNo: buildSellNoTx,
        };
        tx = await builders[action](params);
      }

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
      setStatus(`Error: ${friendlyError(err)}`);
    }
  }, [
    wallet,
    connection,
    action,
    quantity,
    effectivePrice,
    isResting,
    sellNoLimitBlocked,
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

      {wallet && (
        <dl>
          <dt>Yes tokens</dt>
          <dd>{balanceMap.get(yesMint.toString()) ?? 0}</dd>
          <dt>No tokens</dt>
          <dd>{balanceMap.get(noMint.toString()) ?? 0}</dd>
        </dl>
      )}

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

      {effectivePrice != null && (() => {
        const qty = parseInt(quantity || "1");
        const isBuy = action === "buyYes" || action === "buyNo";
        // Net cost: Buy Yes = ask price, Buy No = 1.00 - bid price,
        //           Sell Yes = bid price, Sell No = 1.00 - ask price
        const netPerContract =
          action === "buyYes" || action === "sellYes"
            ? effectivePrice
            : USDC_PER_PAIR - effectivePrice;
        const perContractDollars = (netPerContract / USDC_PER_PAIR).toFixed(2);
        const totalNet = (netPerContract / USDC_PER_PAIR) * qty;
        return (
          <output>
            {isBuy ? (
              <>
                You pay <mark data-tone="blue">${perContractDollars}</mark>.{" "}
                You win <mark data-tone="green">$1.00</mark> if {ticker} closes {action === "buyYes" ? "above" : "below"} ${strikeDollars}.
                {qty > 1 && <> ({qty} contracts: <mark data-tone="blue">${totalNet.toFixed(2)}</mark> total)</>}
              </>
            ) : (
              <>
                You receive <mark data-tone="green">${perContractDollars}</mark> per {action === "sellYes" ? "Yes" : "No"} token sold.
                {qty > 1 && <> ({qty} contracts: <mark data-tone="green">${totalNet.toFixed(2)}</mark> total)</>}
              </>
            )}
          </output>
        );
      })()}

      {conflict && (
        <p><mark data-tone="blue">{conflict}</mark></p>
      )}

      {sellNoLimitBlocked && (
        <p><mark data-tone="blue">Sell No limits require liquidity - use market order or request liquidity below</mark></p>
      )}

      <button
        type="submit"
        disabled={!wallet || effectivePrice == null || !!conflict || sellNoLimitBlocked}
      >
        {!wallet
          ? "Connect wallet"
          : conflict
            ? "Position conflict"
            : sellNoLimitBlocked
              ? "No liquidity"
              : isResting
                ? `Limit ${ACTION_LABELS[action]}`
                : ACTION_LABELS[action]}
      </button>

      {emptyBook && (
        <p><small>Empty book - place a limit order to seed liquidity.</small></p>
      )}

      {status && <small>{status}</small>}
    </form>
  );
}
