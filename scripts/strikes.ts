/**
 * Strike price calculation for MAG7 binary outcome markets.
 *
 * Given a previous closing price, generates strike prices at
 * +/-3%, +/-6%, and +/-9% offsets.
 * All values rounded to nearest $10, deduplicated, and sorted.
 */

const OFFSETS = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];

function roundToNearest10(value: number): number {
  return Math.round(value / 10) * 10;
}

/**
 * Calculate strike prices from a previous closing price.
 * @param previousClose - Previous close in dollars (e.g., 680.00)
 * @returns Sorted, deduplicated array of strike prices in dollars
 */
export function calculateStrikes(previousClose: number): number[] {
  const strikes = OFFSETS.map((offset) =>
    roundToNearest10(previousClose * (1 + offset))
  );

  // Deduplicate and sort ascending
  return [...new Set(strikes)].sort((a, b) => a - b);
}
