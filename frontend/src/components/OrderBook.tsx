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
    const side = label.toLowerCase() as "yes" | "no";
    return (
      <section>
        <h3>{label} side</h3>
        <button
          type="button"
          data-active={focus === side ? "true" : undefined}
          onClick={() => setFocus(side)}
        >
          Focus {label}
        </button>
        <dl>
          <dt>Best ask</dt>
          <dd>{formatUsdcBaseUnits(bestAsk)}</dd>
          <dt>Bid</dt>
          <dd>{formatUsdcCents(bestBid)}</dd>
          <dt>Ask</dt>
          <dd>{formatUsdcCents(bestAsk)}</dd>
          <dt>Depth</dt>
          <dd>{formatContracts(depth)}</dd>
          <dt>Spread</dt>
          <dd>{formatUsdcCents(spread)}</dd>
          <dt>Levels</dt>
          <dd>{bidLevels.length + askLevels.length}</dd>
        </dl>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginTop: "1rem" }}>
          <div>
            <table>
              <thead>
                <tr>
                  <th><mark data-tone="red">Ask cents</mark></th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {askLevels.length === 0 ? (
                  <tr><td colSpan={2}><mark data-tone="muted">No asks</mark></td></tr>
                ) : (
                  askLevels.map((level) => (
                    <tr key={`${label}-ask-${level.price}`}>
                      <td><mark data-tone="red">{formatUsdcCents(level.price)}</mark></td>
                      <td>{formatContracts(level.quantity)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div>
            <table>
              <thead>
                <tr>
                  <th><mark data-tone="green">Bid cents</mark></th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {bidLevels.length === 0 ? (
                  <tr><td colSpan={2}><mark data-tone="muted">No bids</mark></td></tr>
                ) : (
                  bidLevels.map((level) => (
                    <tr key={`${label}-bid-${level.price}`}>
                      <td><mark data-tone="green">{formatUsdcCents(level.price)}</mark></td>
                      <td>{formatContracts(level.quantity)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h3>{title}</h3>
      <p><small>Aggregated book by price level, shown in cents and contracts. Focus: {focus}</small></p>
      <nav>
        <button
          type="button"
          data-active={focus === "yes" ? "true" : undefined}
          onClick={() => setFocus("yes")}
        >
          Yes
        </button>
        <button
          type="button"
          data-active={focus === "no" ? "true" : undefined}
          onClick={() => setFocus("no")}
        >
          No
        </button>
      </nav>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginTop: "1rem" }}>
        {renderSidePanel("Yes", yesBidLevels, yesAskLevels, yesBestBid, yesBestAsk, yesSpread, yesDepth)}
        {renderSidePanel("No", noBidLevels, noAskLevels, noBestBid, noBestAsk, noSpread, noDepth)}
      </div>
    </section>
  );
}
