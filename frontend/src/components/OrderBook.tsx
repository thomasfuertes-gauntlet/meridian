import { useState } from "react";
import type { ParsedOrder } from "../lib/orderbook";
import { formatContracts, formatUsdcBaseUnits, formatUsdcCents } from "../lib/format";

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

function PriceLevelRow({
  level,
  side,
}: {
  level: PriceLevel;
  side: "bid" | "ask";
}) {
  const priceColor = side === "bid" ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-3 py-1.5 text-sm font-mono">
      <span className={priceColor}>{formatUsdcCents(level.price)}</span>
      <span className="justify-self-end text-stone-300">{formatContracts(level.quantity)}</span>
    </div>
  );
}

function depthForOrders(orders: ParsedOrder[]): number {
  return orders.reduce((sum, order) => sum + order.quantity, 0);
}

function aggregateByPrice(orders: ParsedOrder[], side: "bid" | "ask"): PriceLevel[] {
  const levels = new Map<number, number>();
  for (const order of orders) {
    const displayPrice = Math.round(order.price / 10_000) * 10_000;
    levels.set(displayPrice, (levels.get(displayPrice) ?? 0) + order.quantity);
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
  const [focus, setFocus] = useState<"yes" | "no">("yes");
  const yesBidLevels = aggregateByPrice(bids, "bid");
  const yesAskLevels = aggregateByPrice(asks, "ask");
  const noBidLevels = aggregateByPrice(noBids, "bid");
  const noAskLevels = aggregateByPrice(noAsks, "ask");
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

  function renderSidePanel(
    label: "Yes" | "No",
    bidLevels: PriceLevel[],
    askLevels: PriceLevel[],
    bestBid: number | null,
    bestAsk: number | null,
    spread: number | null,
    depth: number
  ) {
    const active = focus === label.toLowerCase();
    return (
      <section
        className={`rounded-[1.35rem] border p-3 transition ${
          active ? "border-sky-400/30 bg-sky-400/8" : "border-white/8 bg-white/[0.03]"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/8 pb-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-stone-500">{label} side</div>
            <div className="mt-1 text-lg font-semibold text-white">{formatUsdcBaseUnits(bestAsk)}</div>
          </div>
          <button
            type="button"
            onClick={() => setFocus(label.toLowerCase() as "yes" | "no")}
            className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.22em] transition ${
              active
                ? "border-sky-300/30 bg-sky-300/12 text-sky-100"
                : "border-white/10 text-stone-400 hover:border-white/20 hover:text-white"
            }`}
          >
            Focus
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] uppercase tracking-[0.18em] text-stone-500">
          <div>Bid</div>
          <div>Ask</div>
          <div>Depth</div>
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-xs text-stone-200">
          <div>{formatUsdcCents(bestBid)}</div>
          <div>{formatUsdcCents(bestAsk)}</div>
          <div>{formatContracts(depth)}</div>
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2 text-[10px] uppercase tracking-[0.18em] text-stone-500">
          <div>Spread</div>
          <div className="col-span-2">Quoted</div>
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-xs text-stone-200">
          <div>{formatUsdcCents(spread)}</div>
          <div className="col-span-2">{bidLevels.length + askLevels.length} levels</div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div>
            <div className="flex items-center justify-between border-b border-white/8 pb-2 text-[10px] uppercase tracking-[0.2em] text-rose-300">
              <span>Ask cents</span>
              <span>Qty</span>
            </div>
            <div className="mt-2 space-y-0.5">
              {askLevels.length === 0 ? (
                <div className="py-3 text-center text-xs text-stone-600">No asks</div>
              ) : (
                askLevels.map((level) => (
                  <PriceLevelRow key={`${label}-ask-${level.price}`} level={level} side="ask" />
                ))
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between border-b border-white/8 pb-2 text-[10px] uppercase tracking-[0.2em] text-emerald-300">
              <span>Bid cents</span>
              <span>Qty</span>
            </div>
            <div className="mt-2 space-y-0.5">
              {bidLevels.length === 0 ? (
                <div className="py-3 text-center text-xs text-stone-600">No bids</div>
              ) : (
                bidLevels.map((level) => (
                  <PriceLevelRow key={`${label}-bid-${level.price}`} level={level} side="bid" />
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-stone-950/85 p-4">
      <div className="mb-4 flex flex-col gap-2 border-b border-white/8 pb-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-stone-400">{title}</h3>
          <p className="mt-1 text-sm text-stone-500">Aggregated book by price level, shown in cents and contracts.</p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] uppercase tracking-[0.22em] text-stone-400">
          Focus {focus}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {renderSidePanel("Yes", yesBidLevels, yesAskLevels, yesBestBid, yesBestAsk, yesSpread, yesDepth)}
        {renderSidePanel("No", noBidLevels, noAskLevels, noBestBid, noBestAsk, noSpread, noDepth)}
      </div>
    </div>
  );
}
