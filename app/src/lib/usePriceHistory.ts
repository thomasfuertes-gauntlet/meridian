import { useRef, useCallback } from "react";

const MAX_POINTS = 60; // ~5 min at 5s intervals

/** Per-ticker price history, shared across components via module scope */
const histories = new Map<string, number[]>();

/** Append a price and return the current history array */
export function usePriceHistory(ticker: string) {
  // Stable ref so we don't re-render on every push
  const histRef = useRef(histories.get(ticker) ?? []);
  if (!histories.has(ticker)) {
    histories.set(ticker, histRef.current);
  }

  const push = useCallback(
    (price: number) => {
      const hist = histRef.current;
      // Skip duplicate consecutive values (Pyth returns same price outside market hours)
      if (hist.length > 0 && hist[hist.length - 1] === price) return hist;
      hist.push(price);
      if (hist.length > MAX_POINTS) hist.shift();
      return hist;
    },
    []
  );

  return { history: histRef.current, push };
}
