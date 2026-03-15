import { useMemo } from "react";
import type { ParsedOrder } from "../lib/orderbook";
import { USDC_PER_PAIR } from "../lib/constants";

interface DepthChartProps {
  bids: ParsedOrder[];
  asks: ParsedOrder[];
}

const W = 400;
const H = 120;
const PAD = { top: 8, right: 8, bottom: 20, left: 8 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

interface Level {
  price: number; // base units
  cumQty: number;
}

function buildCumulativeLevels(
  orders: ParsedOrder[],
  side: "bid" | "ask"
): Level[] {
  // Aggregate by price
  const byPrice = new Map<number, number>();
  for (const order of orders) {
    byPrice.set(order.price, (byPrice.get(order.price) ?? 0) + order.quantity);
  }

  const sorted = [...byPrice.entries()]
    .map(([price, qty]) => ({ price, qty }))
    .sort((a, b) =>
      side === "bid" ? b.price - a.price : a.price - b.price
    );

  // Cumulate: bids from best (highest) outward (descending price)
  //           asks from best (lowest) outward (ascending price)
  let cum = 0;
  return sorted.map(({ price, qty }) => {
    cum += qty;
    return { price, cumQty: cum };
  });
}

export function DepthChart({ bids, asks }: DepthChartProps) {
  const { bidPath, askPath, midLabel, maxQty, priceLabels } = useMemo(() => {
    const bidLevels = buildCumulativeLevels(bids, "bid");
    const askLevels = buildCumulativeLevels(asks, "ask");

    if (bidLevels.length === 0 && askLevels.length === 0) {
      return { bidPath: "", askPath: "", midLabel: null, maxQty: 0, priceLabels: [] };
    }

    // Price range: from lowest bid to highest ask
    const allPrices = [
      ...bidLevels.map((l) => l.price),
      ...askLevels.map((l) => l.price),
    ];
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const priceRange = maxPrice - minPrice || 1;

    // Max cumulative quantity (shared Y scale)
    const mq = Math.max(
      bidLevels[bidLevels.length - 1]?.cumQty ?? 0,
      askLevels[askLevels.length - 1]?.cumQty ?? 0,
      1
    );

    function priceToX(price: number): number {
      return PAD.left + ((price - minPrice) / priceRange) * INNER_W;
    }

    function qtyToY(qty: number): number {
      return PAD.top + INNER_H - (qty / mq) * INNER_H;
    }

    const baseline = PAD.top + INNER_H;

    // Bid path: stepped, right-to-left (best bid first, stepping down in price)
    // Render left-to-right by reversing the levels (worst to best)
    let bp = "";
    if (bidLevels.length > 0) {
      const reversed = [...bidLevels].reverse();
      bp = `M${priceToX(reversed[0].price)},${baseline}`;
      for (const level of reversed) {
        const x = priceToX(level.price);
        const y = qtyToY(level.cumQty);
        bp += ` L${x},${y}`;
      }
      // Close down to baseline
      bp += ` L${priceToX(bidLevels[0].price)},${baseline} Z`;
    }

    // Ask path: stepped, left-to-right (best ask first, stepping up in price)
    let ap = "";
    if (askLevels.length > 0) {
      ap = `M${priceToX(askLevels[0].price)},${baseline}`;
      for (const level of askLevels) {
        const x = priceToX(level.price);
        const y = qtyToY(level.cumQty);
        ap += ` L${x},${y}`;
      }
      const last = askLevels[askLevels.length - 1];
      ap += ` L${priceToX(last.price)},${baseline} Z`;
    }

    // Spread midpoint label
    const bestBid = bidLevels[0]?.price ?? null;
    const bestAsk = askLevels[0]?.price ?? null;
    const mid =
      bestBid != null && bestAsk != null
        ? { x: priceToX((bestBid + bestAsk) / 2), label: `$${((bestBid + bestAsk) / 2 / USDC_PER_PAIR).toFixed(2)}` }
        : null;

    // Price labels for extremes + mid
    const labels: { x: number; label: string }[] = [];
    if (bidLevels.length > 0) {
      const worst = bidLevels[bidLevels.length - 1];
      labels.push({ x: priceToX(worst.price), label: `$${(worst.price / USDC_PER_PAIR).toFixed(2)}` });
    }
    if (askLevels.length > 0) {
      const worst = askLevels[askLevels.length - 1];
      labels.push({ x: priceToX(worst.price), label: `$${(worst.price / USDC_PER_PAIR).toFixed(2)}` });
    }

    return { bidPath: bp, askPath: ap, midLabel: mid, maxQty: mq, priceLabels: labels };
  }, [bids, asks]);

  if (!bidPath && !askPath) return null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", maxHeight: 140 }}
      data-depth-chart
    >
      {/* Bid area */}
      {bidPath && (
        <path d={bidPath} fill="var(--color-bid)" fillOpacity="0.2" stroke="var(--color-bid)" strokeWidth="1.5" />
      )}
      {/* Ask area */}
      {askPath && (
        <path d={askPath} fill="var(--color-ask)" fillOpacity="0.2" stroke="var(--color-ask)" strokeWidth="1.5" />
      )}

      {/* Spread midpoint */}
      {midLabel && (
        <>
          <line
            x1={midLabel.x}
            y1={PAD.top}
            x2={midLabel.x}
            y2={PAD.top + INNER_H}
            stroke="var(--text-dim)"
            strokeWidth="0.5"
            strokeDasharray="2,2"
          />
          <text
            x={midLabel.x}
            y={PAD.top + INNER_H + 14}
            textAnchor="middle"
            fontSize="9"
            fill="var(--text-dim)"
            fontFamily="var(--mono)"
          >
            {midLabel.label}
          </text>
        </>
      )}

      {/* Price range labels */}
      {priceLabels.map((lbl, i) => (
        <text
          key={i}
          x={lbl.x}
          y={PAD.top + INNER_H + 14}
          textAnchor={i === 0 ? "start" : "end"}
          fontSize="9"
          fill="var(--muted)"
          fontFamily="var(--mono)"
        >
          {lbl.label}
        </text>
      ))}

      {/* Max quantity label */}
      {maxQty > 0 && (
        <text
          x={PAD.left + 2}
          y={PAD.top + 8}
          fontSize="9"
          fill="var(--muted)"
          fontFamily="var(--mono)"
        >
          {maxQty}
        </text>
      )}
    </svg>
  );
}
