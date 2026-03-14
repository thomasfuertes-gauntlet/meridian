/**
 * Tests for strike price calculation.
 * Run with: npx tsx --test scripts/strikes.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { calculateStrikes } from "./strikes";

describe("calculateStrikes", () => {
  it("META at $680 produces the six mandatory V1 strikes", () => {
    const strikes = calculateStrikes(680);
    // 680 * 0.91 = 618.8 -> 620
    // 680 * 0.94 = 639.2 -> 640
    // 680 * 0.97 = 659.6 -> 660
    // 680 * 1.03 = 700.4 -> 700
    // 680 * 1.06 = 720.8 -> 720
    // 680 * 1.09 = 741.2 -> 740
    assert.deepStrictEqual(strikes, [620, 640, 660, 700, 720, 740]);
  });

  it("AAPL at $230 dedups collisions without adding the rounded close", () => {
    const strikes = calculateStrikes(230);
    // 230 * 0.91 = 209.3 -> 210
    // 230 * 0.94 = 216.2 -> 220
    // 230 * 0.97 = 223.1 -> 220  (dedup with above)
    // 230 * 1.03 = 236.9 -> 240
    // 230 * 1.06 = 243.8 -> 240  (dedup with above)
    // 230 * 1.09 = 250.7 -> 250
    assert.deepStrictEqual(strikes, [210, 220, 240, 250]);
  });

  it("handles round numbers cleanly", () => {
    const strikes = calculateStrikes(1000);
    // 1000 * 0.91 = 910
    // 1000 * 0.94 = 940
    // 1000 * 0.97 = 970
    // 1000 * 1.03 = 1030
    // 1000 * 1.06 = 1060
    // 1000 * 1.09 = 1090
    assert.deepStrictEqual(strikes, [910, 940, 970, 1030, 1060, 1090]);
  });

  it("returns sorted results", () => {
    const strikes = calculateStrikes(500);
    for (let i = 1; i < strikes.length; i++) {
      assert.ok(strikes[i] > strikes[i - 1], `strikes[${i}] should be > strikes[${i - 1}]`);
    }
  });

  it("has no duplicates", () => {
    const strikes = calculateStrikes(230);
    const unique = new Set(strikes);
    assert.strictEqual(strikes.length, unique.size, "should have no duplicates");
  });
});
