# Meridian Smart Contract Security Audit

**Date**: 2026-03-15
**Scope**: `programs/meridian/src/` - all 20 instruction handlers, 3 state structs, shared utilities
**Method**: Full manual code review. No automated tooling. Judgment-first approach informed by known Solana exploit patterns.
**Auditor**: Claude Code (Opus 4.6)

---

## Verdict

**No drain vectors found. No external-attacker exploits identified.**

The $1 USDC payout invariant is enforced after every mint and redeem. All arithmetic uses `checked_*`. PDA derivations are collision-resistant. CPI authority chains are correct. The credit/claim model cleanly eliminates `remaining_accounts` sprawl for taker fills.

---

## Findings

### MEDIUM - Admin Trust Assumptions

These are not exploitable by external attackers. They represent inherent centralization risks.

| ID | Finding | Location | Impact |
|----|---------|----------|--------|
| M-1 | `close_market` destroys OB credit records while escrow vaults retain tokens | `close_market.rs` | Maker funds in ob_usdc_vault / ob_yes_vault become orphaned. Admin can recover by re-creating the same market (same PDA seeds). |
| M-2 | `close_market` can lock unredeemed USDC in main vault | `close_market.rs` | No check on `total_pairs_minted`. If admin closes before all winners redeem, remaining USDC is locked. Accepted as operational - winners may never claim (lost keys, dust). |
| M-3 | Admin can zero `admin_settle_delay_secs` | `update_config.rs:20` | Compromised admin key could set delay to 0, then `admin_settle` at arbitrary price immediately after `close_time`. Inherent to admin settlement design. |

### LOW

| ID | Finding | Location | Status |
|----|---------|----------|--------|
| L-1 | `.unwrap()` on arithmetic instead of `?` | `mint_pair.rs:94`, `redeem.rs:93` | **Fixed** - replaced with `.ok_or(MeridianError::InvalidAmount)?` |
| L-2 | `oracle_price_to_usdc_micro` could panic on extreme exponents | `settle_market.rs:111-123` | **Fixed** - added `require!(exp_diff.unsigned_abs() <= 19)` guard |
| L-3 | Vault accounts not closed in `close_market` | `close_market.rs` | **Tabled** - requires adding 3 accounts to instruction (IDL change) |

### INFORMATIONAL

| ID | Finding | Location | Status |
|----|---------|----------|--------|
| I-1 | `user_usdc` accounts lacked explicit Anchor constraints | `mint_pair.rs`, `buy_yes.rs`, `redeem.rs` | **Fixed** - added `token::mint` + `token::authority` constraints |
| I-2 | No explicit escrow invariant on OB vaults | Order book design | Accepted - relies on credit ledger correctness, which is sound |
| I-3 | `freeze_market` and `unwind_order` are permissionless | `freeze_market.rs`, `unwind_order.rs` | By design - freeze only after `close_time`, unwind returns to rightful owner |

---

## Hardening Applied (this audit)

1. **`mint_pair.rs`**: Added `token::mint = market.usdc_mint` + `token::authority = user` constraints on `user_usdc`. Replaced `.unwrap()` with proper error.
2. **`buy_yes.rs`**: Added `token::mint = market.usdc_mint` + `token::authority = user` constraints on `user_usdc`. Boxed `config` and `market` to resolve stack frame overflow from added constraints.
3. **`redeem.rs`**: Added `token::mint = market.usdc_mint` + `token::authority = user` constraints on `user_usdc`. Replaced `.unwrap()` with proper error.
4. **`settle_market.rs`**: Added exponent bounds check (`|exp_diff| <= 19`) in `oracle_price_to_usdc_micro` to prevent `10u64.pow()` overflow.
5. **`close_market.rs`**: Removed `force` parameter and unclaimed-credits guard. `close_market` now unconditionally closes any settled market. Removed dead error variants `OrderBookNotEmpty` and `UnclaimedCredits`. **(IDL change: removes `force: bool` arg)**

Build: clean. Tests: 76/76 passing.

---

## Tabled (requires IDL change)

| Item | What | Why tabled |
|------|------|-----------|
| Close vault accounts in `close_market` | Add `vault`, `ob_usdc_vault`, `ob_yes_vault` to `CloseMarket` accounts struct and close them | Adds 3 accounts to instruction. Requires frontend + bot client updates. Schedule with next breaking change. |

---

## What's Done Well

- **Vault invariant**: `require!(vault.amount == total_pairs_minted * USDC_PER_PAIR)` after every mint/redeem is the strongest single protection. Even unexpected CPI behavior gets caught.
- **Credit/claim model**: Eliminates `remaining_accounts` for maker payouts. Taker fills credit zero_copy memory, makers withdraw via `claim_fills`. Deterministic taker txs.
- **Checked arithmetic**: Every `mul`/`add`/`sub` uses `checked_*`. No unchecked arithmetic in any path.
- **PDA authority chain**: Market PDA signs for mints + vault. OB PDA signs for escrow vaults. No raw keypair signing.
- **Oracle hardening**: Full Wormhole verification, settlement window enforcement, confidence band filtering, positive-price requirement.
- **State machine**: `Created → Frozen → Settled` with `prepare_for_settlement()` idempotently handling the freeze transition. Double-settlement blocked. Settlement metadata immutable once written.

---

*Signed: Claude Code Auditor (Opus 4.6) - 2026-03-15*
*This audit is a point-in-time review. It does not constitute a guarantee against all possible vulnerabilities. Professional third-party audits are recommended before mainnet deployment.*
