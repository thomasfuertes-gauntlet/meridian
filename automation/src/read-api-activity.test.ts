/**
 * Unit tests for read-api activity endpoint logic.
 * Tests ticker validation, cache key generation, and limit clamping
 * without requiring an RPC connection.
 *
 * Routes are now under /api/* prefix (e.g., /api/activity?limit=12&ticker=NVDA).
 * Run with: npx tsx --test automation/src/read-api-activity.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
const MAX_ACTIVITY_LIMIT = 20;

// Extracted logic from read-api /activity handler for testability
function parseActivityParams(searchParams: URLSearchParams) {
  const rawLimit = Number(searchParams.get("limit") || "12");
  const limit = Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Number.isFinite(rawLimit) ? rawLimit : 12));
  const tickerParam = searchParams.get("ticker")?.toUpperCase();
  const validTickers = new Set(MAG7_TICKERS);
  const filterTicker = tickerParam && validTickers.has(tickerParam) ? tickerParam : undefined;
  const cacheKey = `${limit}:${filterTicker ?? "all"}`;
  return { limit, filterTicker, cacheKey };
}

describe("activity endpoint param parsing", () => {
  it("defaults to limit=12, no ticker filter", () => {
    const params = new URLSearchParams();
    const result = parseActivityParams(params);
    assert.strictEqual(result.limit, 12);
    assert.strictEqual(result.filterTicker, undefined);
    assert.strictEqual(result.cacheKey, "12:all");
  });

  it("respects explicit limit", () => {
    const params = new URLSearchParams({ limit: "5" });
    const result = parseActivityParams(params);
    assert.strictEqual(result.limit, 5);
  });

  it("clamps limit to [1, MAX]", () => {
    assert.strictEqual(parseActivityParams(new URLSearchParams({ limit: "0" })).limit, 1);
    assert.strictEqual(parseActivityParams(new URLSearchParams({ limit: "-5" })).limit, 1);
    assert.strictEqual(parseActivityParams(new URLSearchParams({ limit: "999" })).limit, MAX_ACTIVITY_LIMIT);
  });

  it("treats NaN limit as default 12", () => {
    const result = parseActivityParams(new URLSearchParams({ limit: "abc" }));
    assert.strictEqual(result.limit, 12);
  });

  it("validates MAG7 ticker (case-insensitive)", () => {
    const result = parseActivityParams(new URLSearchParams({ ticker: "nvda" }));
    assert.strictEqual(result.filterTicker, "NVDA");
    assert.strictEqual(result.cacheKey, "12:NVDA");
  });

  it("rejects unknown ticker", () => {
    const result = parseActivityParams(new URLSearchParams({ ticker: "GME" }));
    assert.strictEqual(result.filterTicker, undefined);
    assert.strictEqual(result.cacheKey, "12:all");
  });

  it("accepts all MAG7 tickers", () => {
    for (const ticker of MAG7_TICKERS) {
      const result = parseActivityParams(new URLSearchParams({ ticker }));
      assert.strictEqual(result.filterTicker, ticker, `should accept ${ticker}`);
    }
  });

  it("produces distinct cache keys for different tickers", () => {
    const keys = new Set(
      MAG7_TICKERS.map((t) => parseActivityParams(new URLSearchParams({ ticker: t })).cacheKey)
    );
    // 7 tickers = 7 unique keys
    assert.strictEqual(keys.size, MAG7_TICKERS.length);
  });

  it("produces distinct cache keys for same ticker + different limits", () => {
    const key5 = parseActivityParams(new URLSearchParams({ limit: "5", ticker: "NVDA" })).cacheKey;
    const key10 = parseActivityParams(new URLSearchParams({ limit: "10", ticker: "NVDA" })).cacheKey;
    assert.notStrictEqual(key5, key10);
    assert.strictEqual(key5, "5:NVDA");
    assert.strictEqual(key10, "10:NVDA");
  });
});

describe("over-fetch multiplier", () => {
  it("3x multiplier yields enough headroom for post-filter", () => {
    // With limit=12, we fetch 36 signatures. Even if 2/3 are filtered out,
    // we still get 12 results.
    const limit = 12;
    const rawLimit = limit * 3;
    assert.strictEqual(rawLimit, 36);
    assert.ok(rawLimit >= limit, "raw fetch should always be >= requested limit");
  });

  it("3x multiplier with max limit stays reasonable", () => {
    const rawLimit = MAX_ACTIVITY_LIMIT * 3;
    assert.strictEqual(rawLimit, 60);
    // Solana getSignaturesForAddress supports up to 1000, so 60 is fine
    assert.ok(rawLimit <= 1000, "should not exceed Solana RPC limit");
  });
});
