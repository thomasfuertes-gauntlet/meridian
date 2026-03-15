import test from "node:test";
import assert from "node:assert/strict";
import { formatUsdcBaseUnits, formatContracts, formatTimestamp, formatRelativePublishTime } from "./format";

test("formatUsdcBaseUnits: null returns '--'", () => {
  assert.equal(formatUsdcBaseUnits(null), "--");
});

test("formatUsdcBaseUnits: 0 returns '$0.00'", () => {
  assert.equal(formatUsdcBaseUnits(0), "$0.00");
});

test("formatUsdcBaseUnits: 1_000_000 returns '$1.00'", () => {
  assert.equal(formatUsdcBaseUnits(1_000_000), "$1.00");
});

test("formatUsdcBaseUnits: 500_000 returns '$0.50'", () => {
  assert.equal(formatUsdcBaseUnits(500_000), "$0.50");
});

test("formatUsdcBaseUnits: 123_456_789 formats with commas", () => {
  assert.equal(formatUsdcBaseUnits(123_456_789), "$123.46");
});

test("formatContracts: formats with commas", () => {
  assert.equal(formatContracts(1234), "1,234");
});

test("formatContracts: small number no comma", () => {
  assert.equal(formatContracts(42), "42");
});

test("formatTimestamp: null returns '--'", () => {
  assert.equal(formatTimestamp(null), "--");
});

test("formatTimestamp: 0 returns '--'", () => {
  assert.equal(formatTimestamp(0), "--");
});

test("formatTimestamp: formats valid timestamp", () => {
  // 2024-01-15 14:30:00 UTC = 1705329000
  const result = formatTimestamp(1705329000);
  // Should contain month abbreviation and time
  assert.ok(result.includes("Jan"), `expected 'Jan' in '${result}'`);
  assert.ok(result.includes("15"), `expected '15' in '${result}'`);
});

test("formatRelativePublishTime: null returns 'Unavailable'", () => {
  assert.equal(formatRelativePublishTime(null), "Unavailable");
});

test("formatRelativePublishTime: 0 returns 'Unavailable'", () => {
  assert.equal(formatRelativePublishTime(0), "Unavailable");
});

test("formatRelativePublishTime: recent time shows seconds", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.match(formatRelativePublishTime(now - 30), /^\d+s ago$/);
});

test("formatRelativePublishTime: minutes ago", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.match(formatRelativePublishTime(now - 120), /^\d+m ago$/);
});

test("formatRelativePublishTime: hours ago", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.match(formatRelativePublishTime(now - 7200), /^\d+h ago$/);
});

test("formatRelativePublishTime: future time clamps to 0s", () => {
  const future = Math.floor(Date.now() / 1000) + 1000;
  assert.equal(formatRelativePublishTime(future), "0s ago");
});
