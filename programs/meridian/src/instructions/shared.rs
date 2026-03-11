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
    require_keys_eq!(
        token_account.owner,
        expected_owner,
        MeridianError::InvalidCounterpartyAccount
    );
    require_keys_eq!(
        token_account.mint,
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
