# Meridian - Architecture Overview

Binary outcome markets for MAG7 stocks on Solana. Users trade Yes/No tokens on whether a stock closes above a strike price. $1 USDC payout invariant.

> **This file**: architecture deep-dive for external review - CLOB design, credit/claim model, comparisons with Phoenix/OpenBook/Drift.
> For developer setup, see `README.md`. For dev context and conventions, see `CLAUDE.md`. 
## TLDR

Meridian is a built-in CLOB (not Phoenix, not OpenBook) with a credit/claim settlement model. Taker fills credit maker balances in OrderBook memory; makers withdraw via `claim_fills`. Taker transactions are fully deterministic - same accounts regardless of book state, no stale-book failures.

---

## Contract Surface

```
initialize_config          -- one-time global setup (admin, oracle policies)
create_strike_market       -- one market per ticker/strike/day (creates OB inline)
add_strike                 -- admin adds intraday strikes
mint_pair                  -- deposit $1 USDC -> 1 Yes + 1 No token
redeem                     -- burn tokens -> withdraw USDC (settled or unsettled pairs)
settle_market              -- permissionless oracle settlement (Pyth pull-based)
admin_settle               -- admin fallback with 1hr delay
pause / unpause            -- emergency circuit breaker
place_order                -- maker-only limit order (bid or ask)
cancel_order               -- owner cancels resting order
buy_yes                    -- taker buys Yes from asks (atomic fill-or-kill)
sell_yes                   -- taker sells Yes into bids (atomic fill-or-kill)
claim_fills                -- withdraw credited fill proceeds (permissionless)
unwind_order               -- permissionless order removal during freeze
freeze_market              -- pre-freeze before settlement window
close_market               -- admin closes settled market (recovers rent)
update_config              -- admin updates oracle policies, settlement delay
```

Frontend composes higher-level actions from these primitives:
- **Buy No** = `mint_pair` + `sell_yes` (one Solana tx, one signature)
- **Sell No** = `buy_yes` + `redeem` (one Solana tx, one signature)

## The Four Trade Paths

The spec requires one order book per market (Yes vs USDC) serving four user actions:

| User Action | Book Side | Contract Path |
|---|---|---|
| Buy Yes | Buy from asks | `buy_yes` |
| Sell Yes | Sell into bids | `sell_yes` |
| Buy No | Mint pair, sell Yes on bid side | `mint_pair` + `sell_yes` |
| Sell No | Buy Yes from asks, redeem pair | `buy_yes` + `redeem` |

Buy Yes and Sell No are the same side of the book (both acquire Yes tokens).
Buy No and Sell Yes are the same side (both dispose of Yes tokens).

---

## CLOB Design: Credit/Claim Model

### How Fills Work

Solana requires every account touched by a transaction to be declared upfront. For a taker fill, the program must transfer tokens to/from counterparty wallets - but which counterparties depends on the current book state.

Meridian solves this with an in-memory credit ledger:

1. **Taker submits** `buy_yes` or `sell_yes` with a fixed set of accounts (market, order book, escrow vaults, own ATAs)
2. **On-chain**, the program walks the book in price-time priority, matches fills
3. **Taker receives** tokens/USDC via CPI transfer (one transfer to taker)
4. **Maker proceeds are credited** in the OrderBook's zero_copy `credits` array - no CPI needed for makers during the fill
5. **Makers call `claim_fills`** whenever convenient to withdraw their credited USDC and/or Yes tokens

### Why Credit/Claim

The original V1 used Anchor's `remaining_accounts` to pass counterparty ATAs at signing time. This worked but had a fundamental liveness problem: if the book changed between the client read and on-chain execution, the transaction failed atomically. Stale-book failures were safe (no bad fills) but frustrating UX, especially with hardware wallet signing latency.

The credit/claim model eliminates this entirely:
- **Taker tx is fully deterministic** - same accounts regardless of book state
- **No stale-book failures** - the taker never needs to know who the makers are
- **Makers claim asynchronously** - similar to Phoenix's seat model, but without per-user seat approval

### OrderBook Layout

```
OrderBook (zero_copy, 7800 bytes):
  Header (112 bytes): market, ob_usdc_vault, ob_yes_vault, next_order_id,
                      bid_count, ask_count, bump, credit_count, padding
  Bids:    32 orders x 72 bytes = 2304 bytes
  Asks:    32 orders x 72 bytes = 2304 bytes
  Credits: 64 entries x 48 bytes = 3072 bytes

CreditEntry (48 bytes):
  owner: Pubkey (32)
  usdc_claimable: u64 (8)
  yes_claimable: u64 (8)
```

### Settlement Integration

When a market settles (`settle_market` or `admin_settle`), the program auto-credits all resting orders via `auto_credit_resting_orders()`. This is pure memory writes (no CPI) - it iterates the bid/ask arrays, credits each maker's escrowed funds back, and zeros the orders. Makers then call `claim_fills` to withdraw. This means settlement doesn't require a drained order book.

**Devnet settlement:** The automation cron fires at 4:07 PM ET and tries `settle_market` first (permissionless, Pyth pull oracle). It fetches a Wormhole-verified VAA from Hermes at `close_time + 30s`, posts a `PriceUpdateV2` account on-chain, and calls `settle_market`. If this fails (VAA publish_time outside the 5-min window, Hermes unavailable, or Wormhole verification issues), it falls back to `admin_settle` with a 1hr delay, retrying until 5:00 PM ET. Set `HERMES_URL=https://hermes-beta.pyth.network` to use devnet-compatible VAAs.

Oracle defaults: staleness threshold 300s (5 min), confidence band reject > 1% of price. Both configurable per ticker in `GlobalConfig.oracle_policies`.

---

## Comparison with Other Solana CLOBs

### Phoenix DEX

Phoenix (Ellipsis Labs) uses per-user per-market "seat" accounts that hold open orders and unsettled balances. Fills credit the maker's seat, and makers claim later.

**How it avoids stale-book failures**: Taker doesn't pass counterparty ATAs. Fills credit seat accounts (known PDAs).

**Tradeoffs vs Meridian**:
- Seat approval requires market authority signature (permission friction) - Meridian has no per-user approval
- Per-user per-market seat accounts add rent costs - Meridian uses a shared credits array (64 entries per book)
- Both require a maker "claim" step
- Devnet program ID is undocumented; CPI docs are sparse

**Reference**: [Phoenix documentation](https://docs.phoenix.trade), [ellipsis-labs/phoenix-v1](https://github.com/ellipsis-labs/phoenix-v1)

### OpenBook (formerly Serum)

OpenBook v2 uses a crank/consume-events model. Fills produce events on a queue; a crank transaction settles to makers.

**How it avoids stale-book failures**: Taker only interacts with book + event queue (known PDAs).

**Tradeoffs vs Meridian**:
- Crank latency and incentivization overhead - Meridian's claim is self-serve
- Event queue adds account size - Meridian's credit array is fixed (3072 bytes)
- More complex program (~10k LOC vs Meridian's ~2k)

**Reference**: [openbook-dex/openbook-v2](https://github.com/openbook-dex/openbook-v2)

### Drift Protocol

Drift uses a JIT auction system for perpetual futures. Takers submit intent, makers compete to fill during an auction window.

**Tradeoffs vs Meridian**:
- Auction window adds latency (not suitable for instant fills)
- Keeper infrastructure required
- Vastly more complex (~50k LOC)
- Designed for perpetuals, not spot/binary outcomes

**Reference**: [drift-labs/protocol-v2](https://github.com/drift-labs/protocol-v2)

### Summary

| Approach | Stale book? | Complexity | Maker UX | Taker UX |
|---|---|---|---|---|
| **Meridian (credit/claim)** | No | Low (~2k LOC) | Place + claim | Sign once |
| **Phoenix (seats)** | No | Medium | Seat approval + claim | Sign once |
| **OpenBook (cranks)** | No | High | Wait for crank | Sign once |
| **Drift (JIT auction)** | No | Very high | Compete in auction | Submit intent |

---

## Aspirational Upgrades (Post-V1)

### Credit Array Scaling

The current 64-entry credit array limits unique makers per order book. For a bot-dominated alpha this is sufficient. Production options:
- Increase `MAX_CREDIT_ENTRIES` (costs account rent)
- Spill to a secondary credit account when primary is full
- Auto-claim oldest entries when array is full

### Event-Driven Claim Automation

Bots currently call `claim_fills` periodically. A production system could use Solana account subscriptions to trigger claims automatically when credits appear, reducing maker latency to ~1 slot.

### Hybrid AMM Backstop

Add a constant-product AMM as fallback liquidity. If the CLOB has insufficient depth, the taker fills against the AMM. Always-available liquidity at the cost of capital efficiency. Not aligned with the spec's pure CLOB requirement but worth considering for production.
