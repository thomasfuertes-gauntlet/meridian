import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { getPositionConflict } from "./portfolio";

const yesMint = new PublicKey("11111111111111111111111111111113");
const noMint = new PublicKey("11111111111111111111111111111114");

function balanceMap(yes: number, no: number): Map<string, number> {
  const m = new Map<string, number>();
  if (yes > 0) m.set(yesMint.toString(), yes);
  if (no > 0) m.set(noMint.toString(), no);
  return m;
}

test("getPositionConflict: no conflict when holding nothing", () => {
  const m = balanceMap(0, 0);
  assert.equal(getPositionConflict(m, yesMint, noMint, "buyYes"), null);
  assert.equal(getPositionConflict(m, yesMint, noMint, "buyNo"), null);
  assert.equal(getPositionConflict(m, yesMint, noMint, "sellYes"), null);
  assert.equal(getPositionConflict(m, yesMint, noMint, "sellNo"), null);
});

test("getPositionConflict: buyYes blocked when holding No tokens", () => {
  const msg = getPositionConflict(balanceMap(0, 3), yesMint, noMint, "buyYes");
  assert.ok(msg !== null);
  assert.ok(msg.includes("No"), "message should mention No tokens");
  assert.ok(msg.includes("3"), "message should include count");
});

test("getPositionConflict: buyNo blocked when holding Yes tokens", () => {
  const msg = getPositionConflict(balanceMap(5, 0), yesMint, noMint, "buyNo");
  assert.ok(msg !== null);
  assert.ok(msg.includes("Yes"), "message should mention Yes tokens");
  assert.ok(msg.includes("5"), "message should include count");
});

test("getPositionConflict: sellYes not blocked by any balance", () => {
  assert.equal(getPositionConflict(balanceMap(0, 10), yesMint, noMint, "sellYes"), null);
  assert.equal(getPositionConflict(balanceMap(10, 10), yesMint, noMint, "sellYes"), null);
});

test("getPositionConflict: sellNo not blocked by any balance", () => {
  assert.equal(getPositionConflict(balanceMap(10, 0), yesMint, noMint, "sellNo"), null);
  assert.equal(getPositionConflict(balanceMap(10, 10), yesMint, noMint, "sellNo"), null);
});

test("getPositionConflict: singular token uses 'token' not 'tokens'", () => {
  const msg = getPositionConflict(balanceMap(0, 1), yesMint, noMint, "buyYes");
  assert.ok(msg !== null);
  assert.ok(!msg.includes("tokens"), `singular should not use 'tokens': "${msg}"`);
  assert.ok(msg.includes("token"), `singular should use 'token': "${msg}"`);
});

test("getPositionConflict: plural tokens uses 'tokens'", () => {
  const msg = getPositionConflict(balanceMap(0, 2), yesMint, noMint, "buyYes");
  assert.ok(msg !== null);
  assert.ok(msg.includes("tokens"), `plural should use 'tokens': "${msg}"`);
});
