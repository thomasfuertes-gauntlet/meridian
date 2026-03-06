import { useState } from "react";
import type { ParsedOrder } from "../lib/orderbook";
import { USDC_PER_PAIR } from "../lib/constants";

interface OrderBookProps {
  bids: ParsedOrder[];
  asks: ParsedOrder[];
  noBids: ParsedOrder[];
  noAsks: ParsedOrder[];
}

function formatPrice(baseUnits: number): string {
  return (baseUnits / USDC_PER_PAIR).toFixed(2);
}

function OrderRow({
  order,
  side,
}: {
  order: ParsedOrder;
  side: "bid" | "ask";
}) {
  const color = side === "bid" ? "text-green-400" : "text-red-400";
  return (
    <div className="flex justify-between text-sm font-mono py-0.5">
      <span className={color}>{formatPrice(order.price)}</span>
      <span className="text-gray-400">{order.quantity}</span>
    </div>
  );
}

export function OrderBook({ bids, asks, noBids, noAsks }: OrderBookProps) {
  const [perspective, setPerspective] = useState<"yes" | "no">("yes");

  const displayBids = perspective === "yes" ? bids : noBids;
  const displayAsks = perspective === "yes" ? asks : noAsks;
  const label = perspective === "yes" ? "Yes" : "No";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-300">
          Order Book ({label})
        </h3>
        <button
          onClick={() =>
            setPerspective((p) => (p === "yes" ? "no" : "yes"))
          }
          className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded px-2 py-0.5"
        >
          Flip to {perspective === "yes" ? "No" : "Yes"}
        </button>
      </div>

      <div className="flex justify-between text-xs text-gray-600 mb-1 px-1">
        <span>Price</span>
        <span>Qty</span>
      </div>

      {/* Asks (lowest first, displayed top to bottom) */}
      <div className="border-b border-gray-800 pb-2 mb-2">
        {displayAsks.length === 0 ? (
          <div className="text-xs text-gray-600 text-center py-2">
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
        <div className="text-xs text-gray-600 text-center py-1">
          Spread: $
          {formatPrice(displayAsks[0].price - displayBids[0].price)}
        </div>
      )}

      {/* Bids (highest first, displayed top to bottom) */}
      <div className="pt-2">
        {displayBids.length === 0 ? (
          <div className="text-xs text-gray-600 text-center py-2">
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
