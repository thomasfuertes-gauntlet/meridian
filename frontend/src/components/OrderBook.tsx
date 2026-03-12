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

interface PriceLevel {
  price: number;
  quantity: number;
}

function OrderRow({
  order,
  side,
}: {
  order: PriceLevel;
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

function depthForOrders(orders: ParsedOrder[]): number {
  return orders.reduce((sum, order) => sum + order.quantity, 0);
}

function aggregateByPrice(orders: ParsedOrder[], side: "bid" | "ask"): PriceLevel[] {
  const levels = new Map<number, number>();
  for (const order of orders) {
    levels.set(order.price, (levels.get(order.price) ?? 0) + order.quantity);
  }

  const aggregated = [...levels.entries()].map(([price, quantity]) => ({
    price,
    quantity,
  }));
  aggregated.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return aggregated;
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
  const displayBidLevels = aggregateByPrice(displayBids, "bid");
  const displayAskLevels = aggregateByPrice(displayAsks, "ask");
  const yesBestBid = bids[0]?.price ?? null;
  const yesBestAsk = asks[0]?.price ?? null;
  const noBestBid = noBids[0]?.price ?? null;
  const noBestAsk = noAsks[0]?.price ?? null;
  const yesSpread =
    yesBestBid != null && yesBestAsk != null ? yesBestAsk - yesBestBid : null;
  const noSpread =
    noBestBid != null && noBestAsk != null ? noBestAsk - noBestBid : null;
  const yesDepth = depthForOrders(bids) + depthForOrders(asks);
  const noDepth = depthForOrders(noBids) + depthForOrders(noAsks);

  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-stone-950/85 p-4">
      <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-stone-400">
          {title} ({label})
        </h3>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Yes market</div>
              <div className="mt-1 grid grid-cols-4 gap-2 text-[10px] uppercase tracking-[0.14em] text-stone-500">
                <span>Bid</span>
                <span>Ask</span>
                <span>Spread</span>
                <span>Depth</span>
              </div>
              <div className="mt-1 grid grid-cols-4 gap-2 font-mono text-xs text-stone-200">
                <span>{formatUsdcBaseUnits(yesBestBid)}</span>
                <span>{formatUsdcBaseUnits(yesBestAsk)}</span>
                <span>{formatUsdcBaseUnits(yesSpread)}</span>
                <span>{yesDepth}</span>
              </div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">No market</div>
              <div className="mt-1 grid grid-cols-4 gap-2 text-[10px] uppercase tracking-[0.14em] text-stone-500">
                <span>Bid</span>
                <span>Ask</span>
                <span>Spread</span>
                <span>Depth</span>
              </div>
              <div className="mt-1 grid grid-cols-4 gap-2 font-mono text-xs text-stone-200">
                <span>{formatUsdcBaseUnits(noBestBid)}</span>
                <span>{formatUsdcBaseUnits(noBestAsk)}</span>
                <span>{formatUsdcBaseUnits(noSpread)}</span>
                <span>{noDepth}</span>
              </div>
            </div>
          </div>
          <button
            onClick={() =>
              setPerspective((p) => (p === "yes" ? "no" : "yes"))
            }
            className="rounded-full border border-white/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-stone-300 transition hover:border-amber-200/40 hover:text-white"
          >
            Flip to {perspective === "yes" ? "No" : "Yes"}
          </button>
        </div>
      </div>

      <div className="mb-1 flex justify-between px-1 text-xs uppercase tracking-[0.2em] text-stone-600">
        <span>Price</span>
        <span>Qty</span>
      </div>

      {/* Asks (lowest first, displayed top to bottom) */}
      <div className="mb-2 border-b border-white/10 pb-2">
        {displayAskLevels.length === 0 ? (
          <div className="py-2 text-center text-xs text-stone-600">
            No asks
          </div>
        ) : (
          [...displayAskLevels].reverse().map((level) => (
            <OrderRow key={`ask-${level.price}`} order={level} side="ask" />
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
        {displayBidLevels.length === 0 ? (
          <div className="py-2 text-center text-xs text-stone-600">
            No bids
          </div>
        ) : (
          displayBidLevels.map((level) => (
            <OrderRow key={`bid-${level.price}`} order={level} side="bid" />
          ))
        )}
      </div>
    </div>
  );
}
