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
      // Cap at MAX_POINTS but always push (flat lines are better than no sparkline)
      hist.push(price);
      if (hist.length > MAX_POINTS) hist.shift();
      return hist;
    },
    [ticker]
  );

  return { history, push };
}
