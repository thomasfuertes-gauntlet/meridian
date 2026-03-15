import { useState } from "react";
import type { ParsedOrder } from "../lib/orderbook";
import { formatContracts, formatUsdcCents } from "../lib/format";

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

  const bidLevels = aggregateByPrice(focus === "yes" ? bids : noBids, "bid");
  const askLevels = aggregateByPrice(focus === "yes" ? asks : noAsks, "ask");
  const bestBid = bidLevels[0]?.price ?? null;
  const bestAsk = askLevels[0]?.price ?? null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const depth = bidLevels.reduce((s, l) => s + l.quantity, 0) + askLevels.reduce((s, l) => s + l.quantity, 0);

  return (
    <section>
      <h3>{title}</h3>
      <nav>
        <button type="button" data-active={focus === "yes" ? "true" : undefined} onClick={() => setFocus("yes")}>
          Yes
        </button>
        <button type="button" data-active={focus === "no" ? "true" : undefined} onClick={() => setFocus("no")}>
          No
        </button>
      </nav>

      <dl>
        <dt>Bid</dt>
        <dd>{formatUsdcCents(bestBid)}</dd>
        <dt>Ask</dt>
        <dd>{formatUsdcCents(bestAsk)}</dd>
        <dt>Spread</dt>
        <dd>{formatUsdcCents(spread)}</dd>
        <dt>Depth</dt>
        <dd>{formatContracts(depth)}</dd>
      </dl>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginTop: "0.5rem" }}>
        <table>
          <thead>
            <tr>
              <th><mark data-tone="green">Bid</mark></th>
              <th>Qty</th>
            </tr>
          </thead>
          <tbody>
            {bidLevels.length === 0 ? (
              <tr><td colSpan={2}><mark data-tone="muted">No bids</mark></td></tr>
            ) : (
              bidLevels.map((level) => (
                <tr key={level.price}>
                  <td><mark data-tone="green">{formatUsdcCents(level.price)}</mark></td>
                  <td>{formatContracts(level.quantity)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <table>
          <thead>
            <tr>
              <th><mark data-tone="red">Ask</mark></th>
              <th>Qty</th>
            </tr>
          </thead>
          <tbody>
            {askLevels.length === 0 ? (
              <tr><td colSpan={2}><mark data-tone="muted">No asks</mark></td></tr>
            ) : (
              askLevels.map((level) => (
                <tr key={level.price}>
                  <td><mark data-tone="red">{formatUsdcCents(level.price)}</mark></td>
                  <td>{formatContracts(level.quantity)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
