import { useState } from "react";
import type { ParsedOrder } from "../lib/orderbook";
import { formatUsdcBaseUnits } from "../lib/format";

interface OrderBookProps {
  bids: ParsedOrder[];
  asks: ParsedOrder[];
  noBids: ParsedOrder[];
  noAsks: ParsedOrder[];
  title?: string;
}

function OrderRow({
  order,
  side,
}: {
  order: ParsedOrder;
  side: "bid" | "ask";
}) {
  const color = side === "bid" ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="flex justify-between py-1 text-sm font-mono">
      <span className={color}>{formatUsdcBaseUnits(order.price)}</span>
      <span className="text-stone-400">{order.quantity}</span>
    </div>
  );
}

export function OrderBook({
  bids,
  asks,
  noBids,
  noAsks,
  title = "Order Book",
}: OrderBookProps) {
  const [perspective, setPerspective] = useState<"yes" | "no">("yes");

  const displayBids = perspective === "yes" ? bids : noBids;
  const displayAsks = perspective === "yes" ? asks : noAsks;
  const label = perspective === "yes" ? "Yes" : "No";

  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-stone-950/85 p-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-stone-400">
          {title} ({label})
        </h3>
        <button
          onClick={() =>
            setPerspective((p) => (p === "yes" ? "no" : "yes"))
          }
          className="rounded-full border border-white/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-stone-300 transition hover:border-amber-200/40 hover:text-white"
        >
          Flip to {perspective === "yes" ? "No" : "Yes"}
        </button>
      </div>

      <div className="mb-1 flex justify-between px-1 text-xs uppercase tracking-[0.2em] text-stone-600">
        <span>Price</span>
        <span>Qty</span>
      </div>

      {/* Asks (lowest first, displayed top to bottom) */}
      <div className="mb-2 border-b border-white/10 pb-2">
        {displayAsks.length === 0 ? (
          <div className="py-2 text-center text-xs text-stone-600">
            No asks
          </div>
        ) : (
          [...displayAsks].reverse().map((o) => (
            <OrderRow key={o.orderId} order={o} side="ask" />
          ))
        )}
      </div>

      {/* Spread indicator */}
      {displayBids.length > 0 && displayAsks.length > 0 && (
        <div className="py-1 text-center text-xs text-stone-500">
          Spread {formatUsdcBaseUnits(displayAsks[0].price - displayBids[0].price)}
        </div>
      )}

      {/* Bids (highest first, displayed top to bottom) */}
      <div className="pt-2">
        {displayBids.length === 0 ? (
          <div className="py-2 text-center text-xs text-stone-600">
            No bids
          </div>
        ) : (
          displayBids.map((o) => (
            <OrderRow key={o.orderId} order={o} side="bid" />
          ))
        )}
      </div>
    </div>
  );
}
