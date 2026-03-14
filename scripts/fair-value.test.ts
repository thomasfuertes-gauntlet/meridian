import test from "node:test";
import assert from "node:assert/strict";
import { fairValue, computeLevels } from "./fair-value";

function assertBetween(val: number, lo: number, hi: number, label?: string) {
  assert.ok(val >= lo && val <= hi, `${label ?? "value"} ${val} not in [${lo}, ${hi}]`);
}

// ── fairValue ───────────────────────────────────────────────────────────────

test("fairValue: at-the-money returns exactly 0.5", () => {
  // x = 0 → sigmoid(0) = 0.5 regardless of k
  assert.equal(fairValue(100, 100), 0.5);
});

test("fairValue: price above strike → probability > 0.5", () => {
  assert.ok(fairValue(110, 100) > 0.5);
});

test("fairValue: price below strike → probability < 0.5", () => {
  assert.ok(fairValue(90, 100) < 0.5);
});

test("fairValue: deep ITM hits 0.95 cap", () => {
  // 100% above strike → sigmoid saturates well above 0.95
  assert.equal(fairValue(200, 100), 0.95);
});

test("fairValue: deep OTM hits 0.05 floor", () => {
  // 50% below strike → sigmoid saturates well below 0.05
  assert.equal(fairValue(50, 100), 0.05);
});

test("fairValue: always bounded [0.05, 0.95]", () => {
  const cases: [number, number, number?][] = [
    [1, 1000, 0],
    [1000, 1, 0],
    [100, 100, 8],
    [99, 100, 0],
    [101, 100, 0],
    [100, 100],
  ];
  for (const [stock, strike, hours] of cases) {
    assertBetween(fairValue(stock, strike, hours), 0.05, 0.95, `fairValue(${stock}, ${strike}, ${hours})`);
  }
});

test("fairValue: near close is steeper than far from close (same price)", () => {
  // k=40 at close vs k=10 far → bigger probability shift for same delta
  const atClose = fairValue(105, 100, 0);
  const farFromClose = fairValue(105, 100, 10); // beyond 8h window → k=10
  assert.ok(atClose > farFromClose, `atClose=${atClose} should exceed farFromClose=${farFromClose}`);
});

test("fairValue: hoursUntilClose=8 matches default (both use k=10)", () => {
  // DECAY_WINDOW_HOURS=8: the branch fires only for hours < 8, so 8 falls through
  const withHours = fairValue(100, 100, 8);
  const withoutHours = fairValue(100, 100);
  assert.ok(Math.abs(withHours - withoutHours) < 1e-12);
});

test("fairValue: linear k interpolation at hoursUntilClose=4 gives k=25", () => {
  // t=4/8=0.5 → k = 10 + 30*0.5 = 25
  // x = 0.05, raw = 1/(1+exp(-25*0.05)) = 1/(1+exp(-1.25))
  const expected = Math.max(0.05, Math.min(0.95, 1 / (1 + Math.exp(-25 * 0.05))));
  const actual = fairValue(105, 100, 4);
  assert.ok(Math.abs(actual - expected) < 1e-12);
});

// ── computeLevels ───────────────────────────────────────────────────────────

test("computeLevels: produces bids and asks at fair value 0.5", () => {
  const { bids, asks } = computeLevels(0.5);
  assert.ok(bids.length > 0, "should have bids");
  assert.ok(asks.length > 0, "should have asks");
});

test("computeLevels: all bids below all asks", () => {
  const { bids, asks } = computeLevels(0.5);
  const maxBid = Math.max(...bids.map(([p]) => p));
  const minAsk = Math.min(...asks.map(([p]) => p));
  assert.ok(maxBid < minAsk, `maxBid=${maxBid} should be < minAsk=${minAsk}`);
});

test("computeLevels: bids sorted high-to-low, asks low-to-high", () => {
  const { bids, asks } = computeLevels(0.5);
  for (let i = 1; i < bids.length; i++) {
    assert.ok(bids[i][0] <= bids[i - 1][0], "bids should be descending");
  }
  for (let i = 1; i < asks.length; i++) {
    assert.ok(asks[i][0] >= asks[i - 1][0], "asks should be ascending");
  }
});

test("computeLevels: extreme fair value near 0.95 keeps no bid >= min ask", () => {
  const { bids, asks } = computeLevels(0.95);
  if (bids.length === 0 || asks.length === 0) return; // valid edge case
  const minAsk = Math.min(...asks.map(([p]) => p));
  for (const [p] of bids) {
    assert.ok(p < minAsk, `bid ${p} should be below min ask ${minAsk}`);
  }
});

test("computeLevels: extreme fair value near 0.05 keeps no ask <= max bid", () => {
  const { bids, asks } = computeLevels(0.05);
  if (bids.length === 0 || asks.length === 0) return; // valid edge case
  const maxBid = Math.max(...bids.map(([p]) => p));
  for (const [p] of asks) {
    assert.ok(p > maxBid, `ask ${p} should be above max bid ${maxBid}`);
  }
});

test("computeLevels: prices are in USDC base units (0-1_000_000)", () => {
  const { bids, asks } = computeLevels(0.5);
  for (const [p] of [...bids, ...asks]) {
    assertBetween(p, 0, 1_000_000, "price");
  }
});
