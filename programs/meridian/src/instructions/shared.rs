use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, MintTo, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::state::{Order, OrderBook, StrikeMarket, MAX_ORDERS_PER_SIDE};

#[derive(Debug, Clone)]
pub struct AtomicFill {
    pub book_index: usize,
    pub fill_qty: u64,
    pub fill_cost: u64,
    pub remaining_acct_idx: usize,
    pub counterparty_owner: Pubkey,
}

// User-facing trade path mapping:
// - buy_yes = escrow_usdc + buy_yes_from_asks + refund_ob_usdc_to_user
// - sell_yes = escrow_yes + sell_yes_into_bids
// - buy_no = mint_complete_set + escrow_yes + sell_yes_into_bids
// - sell_no = escrow_usdc + buy_yes_from_asks + refund_ob_usdc_to_user + burn_complete_set_for_usdc
//
// The helpers below intentionally model the economic steps directly rather than
// collapsing them into a single mode-flagged trade engine.

pub fn plan_bid_fills(
    bids: &[Order; MAX_ORDERS_PER_SIDE],
    bid_count: usize,
    amount: u64,
    min_price: u64,
) -> Result<Vec<AtomicFill>> {
    let mut fills: Vec<AtomicFill> = Vec::new();
    let mut rem_qty = amount;
    let mut ra_idx = 0usize;

    for (i, bid) in bids.iter().enumerate().take(bid_count) {
        if rem_qty == 0 {
            break;
        }
        if bid.is_active == 0 {
            continue;
        }
        if bid.price < min_price {
            break;
        }

        let fill_qty = rem_qty.min(bid.quantity);
        let fill_cost = fill_qty
            .checked_mul(bid.price)
            .ok_or(MeridianError::InvalidAmount)?;

        fills.push(AtomicFill {
            book_index: i,
            fill_qty,
            fill_cost,
            remaining_acct_idx: ra_idx,
            counterparty_owner: bid.owner,
        });
        ra_idx += 1;
        rem_qty = rem_qty
            .checked_sub(fill_qty)
            .ok_or(MeridianError::InvalidAmount)?;
    }

    require!(rem_qty == 0, MeridianError::AtomicTradeIncomplete);
    require!(!fills.is_empty(), MeridianError::NoMatchingOrders);

    Ok(fills)
}

pub fn plan_ask_fills(
    asks: &[Order; MAX_ORDERS_PER_SIDE],
    ask_count: usize,
    amount: u64,
    max_price: u64,
) -> Result<Vec<AtomicFill>> {
    let mut fills: Vec<AtomicFill> = Vec::new();
    let mut rem_qty = amount;
    let mut ra_idx = 0usize;

    for (i, ask) in asks.iter().enumerate().take(ask_count) {
        if rem_qty == 0 {
            break;
        }
        if ask.is_active == 0 {
            continue;
        }
        if ask.price > max_price {
            break;
        }

        let fill_qty = rem_qty.min(ask.quantity);
        let fill_cost = fill_qty
            .checked_mul(ask.price)
            .ok_or(MeridianError::InvalidAmount)?;

        fills.push(AtomicFill {
            book_index: i,
            fill_qty,
            fill_cost,
            remaining_acct_idx: ra_idx,
            counterparty_owner: ask.owner,
        });
        ra_idx += 1;
        rem_qty = rem_qty
            .checked_sub(fill_qty)
            .ok_or(MeridianError::InvalidAmount)?;
    }

    require!(rem_qty == 0, MeridianError::AtomicTradeIncomplete);
    require!(!fills.is_empty(), MeridianError::NoMatchingOrders);

    Ok(fills)
}

pub fn total_fill_cost(fills: &[AtomicFill]) -> Result<u64> {
    fills.iter().try_fold(0u64, |acc, fill| {
        acc.checked_add(fill.fill_cost)
            .ok_or_else(|| error!(MeridianError::InvalidAmount))
    })
}

pub fn compute_refund(escrow_amount: u64, total_fill_cost: u64) -> Result<u64> {
    escrow_amount
        .checked_sub(total_fill_cost)
        .ok_or_else(|| error!(MeridianError::InvalidAmount))
}

pub fn escrow_usdc<'info>(
    token_program: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            token_program,
            Transfer {
                from,
                to,
                authority,
            },
        ),
        amount,
    )
}

pub fn escrow_yes<'info>(
    token_program: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            token_program,
            Transfer {
                from,
                to,
                authority,
            },
        ),
        amount,
    )
}

pub fn refund_ob_usdc_to_user<'info>(
    token_program: AccountInfo<'info>,
    order_book_authority: AccountInfo<'info>,
    user_usdc: AccountInfo<'info>,
    ob_usdc_vault: AccountInfo<'info>,
    ob_signer: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    token::transfer(
        CpiContext::new_with_signer(
            token_program,
            Transfer {
                from: ob_usdc_vault,
                to: user_usdc,
                authority: order_book_authority,
            },
            ob_signer,
        ),
        amount,
    )
}

pub fn mint_complete_set<'info>(
    token_program: AccountInfo<'info>,
    user_authority: AccountInfo<'info>,
    market_authority: AccountInfo<'info>,
    user_usdc: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    yes_mint: AccountInfo<'info>,
    no_mint: AccountInfo<'info>,
    user_yes: AccountInfo<'info>,
    user_no: AccountInfo<'info>,
    market_signer: &[&[&[u8]]],
    amount: u64,
    usdc_per_pair: u64,
) -> Result<()> {
    let usdc_amount = amount
        .checked_mul(usdc_per_pair)
        .ok_or(MeridianError::InvalidAmount)?;

    escrow_usdc(
        token_program.clone(),
        user_authority.clone(),
        user_usdc,
        vault,
        usdc_amount,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            MintTo {
                mint: yes_mint,
                to: user_yes,
                authority: market_authority.clone(),
            },
            market_signer,
        ),
        amount,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            token_program,
            MintTo {
                mint: no_mint,
                to: user_no,
                authority: market_authority,
            },
            market_signer,
        ),
        amount,
    )
}

pub fn burn_complete_set_for_usdc<'info>(
    token_program: AccountInfo<'info>,
    user_authority: AccountInfo<'info>,
    market_authority: AccountInfo<'info>,
    yes_mint: AccountInfo<'info>,
    no_mint: AccountInfo<'info>,
    user_yes: AccountInfo<'info>,
    user_no: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    user_usdc: AccountInfo<'info>,
    market_signer: &[&[&[u8]]],
    amount: u64,
    usdc_per_pair: u64,
) -> Result<()> {
    token::burn(
        CpiContext::new(
            token_program.clone(),
            Burn {
                mint: yes_mint,
                from: user_yes,
                authority: user_authority.clone(),
            },
        ),
        amount,
    )?;

    token::burn(
        CpiContext::new(
            token_program.clone(),
            Burn {
                mint: no_mint,
                from: user_no,
                authority: user_authority.clone(),
            },
        ),
        amount,
    )?;

    let usdc_amount = amount
        .checked_mul(usdc_per_pair)
        .ok_or(MeridianError::InvalidAmount)?;

    token::transfer(
        CpiContext::new_with_signer(
            token_program,
            Transfer {
                from: vault,
                to: user_usdc,
                authority: market_authority,
            },
            market_signer,
        ),
        usdc_amount,
    )
}

pub fn compact_orders(orders: &mut [Order; MAX_ORDERS_PER_SIDE], count: u16) -> u16 {
    let mut write = 0usize;
    let n = count as usize;
    for read in 0..n {
        if orders[read].is_active != 0 {
            if write != read {
                orders[write] = orders[read];
            }
            write += 1;
        }
    }
    for item in orders.iter_mut().take(n).skip(write) {
        *item = Order::default();
    }
    write as u16
}

pub fn validate_order_book_drained<'info>(
    market: &StrikeMarket,
    market_key: &Pubkey,
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<()> {
    if !market.has_order_book() {
        return Ok(());
    }

    require!(
        remaining_accounts.len() >= 3,
        MeridianError::MissingOrderBookAccounts
    );

    let order_book_ai = &remaining_accounts[0];
    let ob_usdc_vault_ai = &remaining_accounts[1];
    let ob_yes_vault_ai = &remaining_accounts[2];

    require_keys_eq!(
        *order_book_ai.key,
        market.order_book,
        MeridianError::InvalidOrderBookAccount
    );
    require_keys_eq!(
        *ob_usdc_vault_ai.key,
        market.ob_usdc_vault,
        MeridianError::InvalidOrderBookAccount
    );
    require_keys_eq!(
        *ob_yes_vault_ai.key,
        market.ob_yes_vault,
        MeridianError::InvalidOrderBookAccount
    );

    let order_book = AccountLoader::<OrderBook>::try_from(order_book_ai)
        .map_err(|_| error!(MeridianError::InvalidOrderBookAccount))?;
    let ob = order_book
        .load()
        .map_err(|_| error!(MeridianError::InvalidOrderBookAccount))?;
    require_keys_eq!(
        ob.market,
        *market_key,
        MeridianError::InvalidOrderBookAccount
    );
    require!(!ob.has_active_orders(), MeridianError::OrderBookNotEmpty);

    let ob_usdc_vault = Account::<TokenAccount>::try_from(ob_usdc_vault_ai)
        .map_err(|_| error!(MeridianError::InvalidOrderBookAccount))?;
    let ob_yes_vault = Account::<TokenAccount>::try_from(ob_yes_vault_ai)
        .map_err(|_| error!(MeridianError::InvalidOrderBookAccount))?;

    validate_order_book_snapshot(
        true,
        ob.has_active_orders(),
        ob_usdc_vault.amount,
        ob_yes_vault.amount,
    )
}

pub fn validate_order_book_snapshot(
    has_order_book: bool,
    has_active_orders: bool,
    ob_usdc_amount: u64,
    ob_yes_amount: u64,
) -> Result<()> {
    if !has_order_book {
        return Ok(());
    }

    require!(!has_active_orders, MeridianError::OrderBookNotEmpty);
    require!(
        ob_usdc_amount == 0 && ob_yes_amount == 0,
        MeridianError::OrderBookEscrowNotEmpty
    );

    Ok(())
}

pub fn validate_order_book_for_market(
    order_book: &OrderBook,
    market_key: &Pubkey,
    ob_usdc_vault: Pubkey,
    ob_yes_vault: Pubkey,
) -> Result<()> {
    require_keys_eq!(order_book.market, *market_key, MeridianError::Unauthorized);
    require_keys_eq!(
        order_book.ob_usdc_vault,
        ob_usdc_vault,
        MeridianError::VaultInvariantViolation
    );
    require_keys_eq!(
        order_book.ob_yes_vault,
        ob_yes_vault,
        MeridianError::VaultInvariantViolation
    );
    Ok(())
}

pub fn validate_counterparty_token_account(
    token_account: &TokenAccount,
    expected_owner: Pubkey,
    expected_mint: Pubkey,
) -> Result<()> {
    validate_counterparty_owner_and_mint(
        token_account.owner,
        token_account.mint,
        expected_owner,
        expected_mint,
    )
}

fn validate_counterparty_owner_and_mint(
    actual_owner: Pubkey,
    actual_mint: Pubkey,
    expected_owner: Pubkey,
    expected_mint: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        actual_owner,
        expected_owner,
        MeridianError::InvalidCounterpartyAccount
    );
    require_keys_eq!(
        actual_mint,
        expected_mint,
        MeridianError::InvalidCounterpartyAccount
    );
    Ok(())
}

pub fn apply_fills_to_orders(
    orders: &mut [Order; MAX_ORDERS_PER_SIDE],
    count: u16,
    fills: &[AtomicFill],
) -> Result<u16> {
    for fill in fills {
        orders[fill.book_index].quantity = orders[fill.book_index]
            .quantity
            .checked_sub(fill.fill_qty)
            .ok_or(MeridianError::InvalidAmount)?;
        if orders[fill.book_index].quantity == 0 {
            orders[fill.book_index].is_active = 0;
        }
    }
    Ok(compact_orders(orders, count))
}

pub fn buy_yes_from_asks<'info>(
    token_program: AccountInfo<'info>,
    order_book_authority: AccountInfo<'info>,
    user_yes: AccountInfo<'info>,
    ob_usdc_vault: &Account<'info, TokenAccount>,
    ob_yes_vault: &Account<'info, TokenAccount>,
    ob_signer: &[&[&[u8]]],
    fills: &[AtomicFill],
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<()> {
    for fill in fills {
        require!(
            fill.remaining_acct_idx < remaining_accounts.len(),
            MeridianError::MissingCounterpartyAccount
        );
        let counterparty_ata = &remaining_accounts[fill.remaining_acct_idx];
        let counterparty_token_account = Account::<TokenAccount>::try_from(counterparty_ata)
            .map_err(|_| MeridianError::InvalidCounterpartyAccount)?;

        validate_counterparty_token_account(
            &counterparty_token_account,
            fill.counterparty_owner,
            ob_usdc_vault.mint,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                token_program.clone(),
                Transfer {
                    from: ob_yes_vault.to_account_info(),
                    to: user_yes.clone(),
                    authority: order_book_authority.clone(),
                },
                ob_signer,
            ),
            fill.fill_qty,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                token_program.clone(),
                Transfer {
                    from: ob_usdc_vault.to_account_info(),
                    to: counterparty_ata.to_account_info(),
                    authority: order_book_authority.clone(),
                },
                ob_signer,
            ),
            fill.fill_cost,
        )?;
    }

    Ok(())
}

pub fn sell_yes_into_bids<'info>(
    token_program: AccountInfo<'info>,
    order_book_authority: AccountInfo<'info>,
    user_usdc: AccountInfo<'info>,
    ob_usdc_vault: &Account<'info, TokenAccount>,
    ob_yes_vault: &Account<'info, TokenAccount>,
    ob_signer: &[&[&[u8]]],
    fills: &[AtomicFill],
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<()> {
    for fill in fills {
        require!(
            fill.remaining_acct_idx < remaining_accounts.len(),
            MeridianError::MissingCounterpartyAccount
        );
        let counterparty_ata = &remaining_accounts[fill.remaining_acct_idx];
        let counterparty_token_account = Account::<TokenAccount>::try_from(counterparty_ata)
            .map_err(|_| MeridianError::InvalidCounterpartyAccount)?;

        validate_counterparty_token_account(
            &counterparty_token_account,
            fill.counterparty_owner,
            ob_yes_vault.mint,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                token_program.clone(),
                Transfer {
                    from: ob_usdc_vault.to_account_info(),
                    to: user_usdc.clone(),
                    authority: order_book_authority.clone(),
                },
                ob_signer,
            ),
            fill.fill_cost,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                token_program.clone(),
                Transfer {
                    from: ob_yes_vault.to_account_info(),
                    to: counterparty_ata.to_account_info(),
                    authority: order_book_authority.clone(),
                },
                ob_signer,
            ),
            fill.fill_qty,
        )?;
    }

    Ok(())
}

pub fn assert_market_vault_invariant(
    market: &StrikeMarket,
    vault_amount: u64,
    usdc_per_pair: u64,
) -> Result<()> {
    let expected_vault = market.expected_vault_amount(usdc_per_pair)?;
    require!(
        vault_amount == expected_vault,
        MeridianError::VaultInvariantViolation
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{MarketOutcome, MarketStatus};

    fn order(owner: Pubkey, price: u64, quantity: u64, order_id: u64, active: bool) -> Order {
        Order {
            owner,
            price,
            quantity,
            timestamp: 0,
            order_id,
            is_active: u8::from(active),
            _padding: [0; 7],
        }
    }

    fn sample_market(total_pairs_minted: u64) -> StrikeMarket {
        StrikeMarket {
            ticker: "META".to_string(),
            strike_price: 680_000_000,
            date: 1_700_000_000,
            status: MarketStatus::Created,
            outcome: MarketOutcome::Pending,
            total_pairs_minted,
            yes_mint: Pubkey::default(),
            no_mint: Pubkey::default(),
            vault: Pubkey::default(),
            usdc_mint: Pubkey::default(),
            order_book: Pubkey::default(),
            ob_usdc_vault: Pubkey::default(),
            ob_yes_vault: Pubkey::default(),
            admin: Pubkey::default(),
            bump: 255,
            frozen_at: None,
            settled_at: None,
            settlement_price: None,
            settlement_source: None,
            close_time: 0,
        }
    }

    fn sample_order_book(market: Pubkey, ob_usdc_vault: Pubkey, ob_yes_vault: Pubkey) -> OrderBook {
        OrderBook {
            market,
            ob_usdc_vault,
            ob_yes_vault,
            next_order_id: 1,
            bid_count: 0,
            ask_count: 0,
            bump: 255,
            _padding: [0; 3],
            bids: [Order::default(); MAX_ORDERS_PER_SIDE],
            asks: [Order::default(); MAX_ORDERS_PER_SIDE],
        }
    }

    #[test]
    fn plan_bid_fills_skips_inactive_orders_and_keeps_remaining_account_index_dense() {
        let owner_a = Pubkey::new_unique();
        let owner_b = Pubkey::new_unique();
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(owner_a, 650_000, 2, 1, false);
        bids[1] = order(owner_b, 640_000, 2, 2, true);

        let fills = plan_bid_fills(&bids, 2, 2, 600_000).unwrap();
        assert_eq!(fills.len(), 1);
        assert_eq!(fills[0].book_index, 1);
        assert_eq!(fills[0].remaining_acct_idx, 0);
        assert_eq!(fills[0].counterparty_owner, owner_b);
    }

    #[test]
    fn plan_ask_fills_skips_inactive_orders_and_keeps_remaining_account_index_dense() {
        let owner_a = Pubkey::new_unique();
        let owner_b = Pubkey::new_unique();
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(owner_a, 300_000, 1, 1, false);
        asks[1] = order(owner_b, 350_000, 2, 2, true);

        let fills = plan_ask_fills(&asks, 2, 2, 400_000).unwrap();
        assert_eq!(fills.len(), 1);
        assert_eq!(fills[0].book_index, 1);
        assert_eq!(fills[0].remaining_acct_idx, 0);
        assert_eq!(fills[0].counterparty_owner, owner_b);
    }

    #[test]
    fn compact_orders_removes_inactive_entries_and_preserves_order() {
        let owner_a = Pubkey::new_unique();
        let owner_b = Pubkey::new_unique();
        let owner_c = Pubkey::new_unique();
        let mut orders = [Order::default(); MAX_ORDERS_PER_SIDE];
        orders[0] = order(owner_a, 650_000, 2, 1, true);
        orders[1] = order(owner_b, 640_000, 1, 2, false);
        orders[2] = order(owner_c, 630_000, 3, 3, true);

        let new_count = compact_orders(&mut orders, 3);
        assert_eq!(new_count, 2);
        assert_eq!(orders[0].owner, owner_a);
        assert_eq!(orders[1].owner, owner_c);
        assert_eq!(orders[2].is_active, 0);
    }

    #[test]
    fn total_fill_cost_rejects_overflow() {
        let fills = vec![
            AtomicFill {
                book_index: 0,
                fill_qty: 1,
                fill_cost: u64::MAX,
                remaining_acct_idx: 0,
                counterparty_owner: Pubkey::new_unique(),
            },
            AtomicFill {
                book_index: 1,
                fill_qty: 1,
                fill_cost: 1,
                remaining_acct_idx: 1,
                counterparty_owner: Pubkey::new_unique(),
            },
        ];

        let err = total_fill_cost(&fills).unwrap_err();
        assert!(err.to_string().contains("InvalidAmount"));
    }

    #[test]
    fn compute_refund_returns_zero_when_no_price_improvement() {
        assert_eq!(compute_refund(1_000_000, 1_000_000).unwrap(), 0);
    }

    #[test]
    fn compute_refund_returns_exact_price_improvement() {
        assert_eq!(compute_refund(1_000_000, 820_000).unwrap(), 180_000);
    }

    #[test]
    fn compute_refund_rejects_fill_cost_above_escrow() {
        let err = compute_refund(999_999, 1_000_000).unwrap_err();
        assert!(err.to_string().contains("InvalidAmount"));
    }

    #[test]
    fn apply_fills_compacts_partially_and_fully_filled_orders() {
        let owner_a = Pubkey::new_unique();
        let owner_b = Pubkey::new_unique();
        let owner_c = Pubkey::new_unique();
        let mut orders = [Order::default(); MAX_ORDERS_PER_SIDE];
        orders[0] = order(owner_a, 650_000, 2, 1, true);
        orders[1] = order(owner_b, 640_000, 1, 2, true);
        orders[2] = order(owner_c, 630_000, 4, 3, true);

        let fills = vec![
            AtomicFill {
                book_index: 0,
                fill_qty: 2,
                fill_cost: 1_300_000,
                remaining_acct_idx: 0,
                counterparty_owner: owner_a,
            },
            AtomicFill {
                book_index: 1,
                fill_qty: 1,
                fill_cost: 640_000,
                remaining_acct_idx: 1,
                counterparty_owner: owner_b,
            },
            AtomicFill {
                book_index: 2,
                fill_qty: 1,
                fill_cost: 630_000,
                remaining_acct_idx: 2,
                counterparty_owner: owner_c,
            },
        ];

        let new_count = apply_fills_to_orders(&mut orders, 3, &fills).unwrap();
        assert_eq!(new_count, 1);
        assert_eq!(orders[0].owner, owner_c);
        assert_eq!(orders[0].quantity, 3);
        assert_eq!(orders[0].is_active, 1);
        assert_eq!(orders[1].is_active, 0);
        assert_eq!(orders[1].quantity, 0);
    }

    #[test]
    fn apply_fills_rejects_overfill() {
        let owner = Pubkey::new_unique();
        let mut orders = [Order::default(); MAX_ORDERS_PER_SIDE];
        orders[0] = order(owner, 650_000, 1, 1, true);

        let fills = vec![AtomicFill {
            book_index: 0,
            fill_qty: 2,
            fill_cost: 1_300_000,
            remaining_acct_idx: 0,
            counterparty_owner: owner,
        }];

        let err = apply_fills_to_orders(&mut orders, 1, &fills).unwrap_err();
        assert!(err.to_string().contains("InvalidAmount"));
    }

    #[test]
    fn market_vault_invariant_accepts_exact_balance() {
        let market = sample_market(3);
        assert_market_vault_invariant(&market, 3_000_000, 1_000_000).unwrap();
    }

    #[test]
    fn market_vault_invariant_rejects_balance_mismatch() {
        let market = sample_market(3);
        let err = assert_market_vault_invariant(&market, 2_999_999, 1_000_000).unwrap_err();
        assert!(err.to_string().contains("VaultInvariantViolation"));
    }

    #[test]
    fn validate_order_book_snapshot_allows_absent_order_book_even_with_nonzero_amounts() {
        validate_order_book_snapshot(false, true, 123, 456).unwrap();
    }

    #[test]
    fn validate_order_book_snapshot_allows_present_empty_book_with_zero_escrow() {
        validate_order_book_snapshot(true, false, 0, 0).unwrap();
    }

    #[test]
    fn validate_order_book_snapshot_rejects_present_book_with_active_orders() {
        let err = validate_order_book_snapshot(true, true, 0, 0).unwrap_err();
        assert!(err.to_string().contains("OrderBookNotEmpty"));
    }

    #[test]
    fn validate_order_book_snapshot_rejects_present_book_with_residual_yes_escrow() {
        let err = validate_order_book_snapshot(true, false, 0, 1).unwrap_err();
        assert!(err.to_string().contains("OrderBookEscrowNotEmpty"));
    }

    #[test]
    fn validate_order_book_for_market_accepts_matching_keys() {
        let market_key = Pubkey::new_unique();
        let ob_usdc_vault = Pubkey::new_unique();
        let ob_yes_vault = Pubkey::new_unique();
        let order_book = sample_order_book(market_key, ob_usdc_vault, ob_yes_vault);

        validate_order_book_for_market(&order_book, &market_key, ob_usdc_vault, ob_yes_vault)
            .unwrap();
    }

    #[test]
    fn validate_order_book_for_market_rejects_market_mismatch() {
        let order_book = sample_order_book(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );

        let err = validate_order_book_for_market(
            &order_book,
            &Pubkey::new_unique(),
            order_book.ob_usdc_vault,
            order_book.ob_yes_vault,
        )
        .unwrap_err();
        assert!(err.to_string().contains("Unauthorized"));
    }

    #[test]
    fn validate_order_book_for_market_rejects_vault_mismatch() {
        let market_key = Pubkey::new_unique();
        let order_book = sample_order_book(
            market_key,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );

        let err = validate_order_book_for_market(
            &order_book,
            &market_key,
            Pubkey::new_unique(),
            order_book.ob_yes_vault,
        )
        .unwrap_err();
        assert!(err.to_string().contains("VaultInvariantViolation"));
    }

    #[test]
    fn validate_counterparty_token_account_accepts_matching_owner_and_mint() {
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        validate_counterparty_owner_and_mint(owner, mint, owner, mint).unwrap();
    }

    #[test]
    fn validate_counterparty_token_account_rejects_owner_mismatch() {
        let mint = Pubkey::new_unique();
        let err = validate_counterparty_owner_and_mint(
            Pubkey::new_unique(),
            mint,
            Pubkey::new_unique(),
            mint,
        )
        .unwrap_err();
        assert!(err.to_string().contains("InvalidCounterpartyAccount"));
    }

    #[test]
    fn validate_counterparty_token_account_rejects_mint_mismatch() {
        let owner = Pubkey::new_unique();
        let err = validate_counterparty_owner_and_mint(
            owner,
            Pubkey::new_unique(),
            owner,
            Pubkey::new_unique(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("InvalidCounterpartyAccount"));
    }

    #[test]
    fn plan_bid_fills_rejects_when_mixed_active_depth_is_still_insufficient() {
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(Pubkey::new_unique(), 650_000, 1, 1, false);
        bids[1] = order(Pubkey::new_unique(), 640_000, 1, 2, true);
        bids[2] = order(Pubkey::new_unique(), 630_000, 1, 3, true);

        let err = plan_bid_fills(&bids, 3, 3, 600_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }

    #[test]
    fn plan_ask_fills_rejects_when_mixed_active_depth_is_still_insufficient() {
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(Pubkey::new_unique(), 300_000, 1, 1, false);
        asks[1] = order(Pubkey::new_unique(), 350_000, 1, 2, true);
        asks[2] = order(Pubkey::new_unique(), 360_000, 1, 3, true);

        let err = plan_ask_fills(&asks, 3, 3, 400_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }
}
