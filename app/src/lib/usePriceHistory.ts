import { useCallback } from "react";

const MAX_POINTS = 60; // ~5 min at 5s intervals

/** Per-ticker price history, shared across components via module scope */
const histories = new Map<string, number[]>();

function getHistory(ticker: string): number[] {
  let hist = histories.get(ticker);
  if (!hist) {
    hist = [];
    histories.set(ticker, hist);
  }
  return hist;
}

/** Append a price and return the current history array */
export function usePriceHistory(ticker: string) {
  const history = getHistory(ticker);

  const push = useCallback(
    (price: number) => {
      const hist = getHistory(ticker);
      // Skip duplicate consecutive values (Pyth returns same price outside market hours)
      if (hist.length > 0 && hist[hist.length - 1] === price) return hist;
      hist.push(price);
      if (hist.length > MAX_POINTS) hist.shift();
      return hist;
    },
    [ticker]
  );

  return { history, push };
}
