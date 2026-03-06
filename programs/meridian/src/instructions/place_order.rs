use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::MeridianError;
use crate::state::{
    GlobalConfig, StrikeMarket, OrderBook, OrderSide, Order, MarketOutcome,
    MAX_ORDERS_PER_SIDE, USDC_PER_PAIR,
};

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        seeds = [
            StrikeMarket::SEED,
            market.ticker.as_bytes(),
            &market.strike_price.to_le_bytes(),
            &market.date.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, StrikeMarket>,

    // AccountLoader for zero_copy - constraints validated in handler
    #[account(
        mut,
        seeds = [OrderBook::SEED, market.key().as_ref()],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    #[account(
        mut,
        seeds = [b"ob_usdc_vault", market.key().as_ref()],
        bump,
    )]
    pub ob_usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"ob_yes_vault", market.key().as_ref()],
        bump,
    )]
    pub ob_yes_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_yes: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
    side: OrderSide,
    price: u64,
    quantity: u64,
) -> Result<()> {
    // Cache keys before borrowing order_book
    let market_key = ctx.accounts.market.key();
    let order_book_ai = ctx.accounts.order_book.to_account_info();

    // --- Validation ---
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(
        ctx.accounts.market.outcome == MarketOutcome::Pending,
        MeridianError::MarketAlreadySettled
    );
    require!(price > 0 && price < USDC_PER_PAIR, MeridianError::InvalidPrice);
    require!(quantity > 0, MeridianError::InvalidAmount);

    // Validate order_book fields that we can't check in account constraints with AccountLoader
    {
        let ob = ctx.accounts.order_book.load()?;
        require!(ob.market == market_key, MeridianError::Unauthorized);
        require!(
            ob.ob_usdc_vault == ctx.accounts.ob_usdc_vault.key(),
            MeridianError::VaultInvariantViolation
        );
        require!(
            ob.ob_yes_vault == ctx.accounts.ob_yes_vault.key(),
            MeridianError::VaultInvariantViolation
        );
    }

    // --- Escrow incoming tokens ---
    let escrow_amount = match side {
        OrderSide::Bid => quantity.checked_mul(price).ok_or(MeridianError::InvalidAmount)?,
        OrderSide::Ask => quantity,
    };

    match side {
        OrderSide::Bid => {
            // Transfer USDC from user to ob_usdc_vault
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_usdc.to_account_info(),
                        to: ctx.accounts.ob_usdc_vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                escrow_amount,
            )?;
        }
        OrderSide::Ask => {
            // Transfer Yes tokens from user to ob_yes_vault
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_yes.to_account_info(),
                        to: ctx.accounts.ob_yes_vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                escrow_amount,
            )?;
        }
    }

    // --- Load order book mutably for matching ---
    let mut ob = ctx.accounts.order_book.load_mut()?;
    let ob_seeds: &[&[u8]] = &[OrderBook::SEED, market_key.as_ref(), &[ob.bump]];
    let ob_signer_seeds = &[ob_seeds];

    let clock = Clock::get()?;
    let mut remaining_qty = quantity;
    let mut remaining_idx: usize = 0; // index into remaining_accounts
    let mut total_fill_cost: u64 = 0; // tracks actual USDC spent (for bid refunds)

    match side {
        OrderSide::Bid => {
            // Match against asks, lowest price first (asks are sorted ascending)
            let ask_count = ob.ask_count as usize;
            for i in 0..ask_count {
                if remaining_qty == 0 {
                    break;
                }
                if ob.asks[i].is_active == 0 {
                    continue;
                }
                let ask_price = ob.asks[i].price;
                if ask_price > price {
                    break; // asks are sorted ascending, no more matches
                }

                let fill_qty = remaining_qty.min(ob.asks[i].quantity);
                let fill_cost = fill_qty
                    .checked_mul(ask_price)
                    .ok_or(MeridianError::InvalidAmount)?;
                total_fill_cost = total_fill_cost
                    .checked_add(fill_cost)
                    .ok_or(MeridianError::InvalidAmount)?;

                // Transfer Yes tokens from ob_yes_vault to taker (user_yes)
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.ob_yes_vault.to_account_info(),
                            to: ctx.accounts.user_yes.to_account_info(),
                            authority: order_book_ai.clone(),
                        },
                        ob_signer_seeds,
                    ),
                    fill_qty,
                )?;

                // Transfer USDC from ob_usdc_vault to counterparty (ask owner's USDC ATA)
                require!(
                    remaining_idx < ctx.remaining_accounts.len(),
                    MeridianError::InvalidAmount
                );
                let counterparty_usdc = &ctx.remaining_accounts[remaining_idx];
                remaining_idx += 1;

                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.ob_usdc_vault.to_account_info(),
                            to: counterparty_usdc.to_account_info(),
                            authority: order_book_ai.clone(),
                        },
                        ob_signer_seeds,
                    ),
                    fill_cost,
                )?;

                ob.asks[i].quantity = ob.asks[i]
                    .quantity
                    .checked_sub(fill_qty)
                    .ok_or(MeridianError::InvalidAmount)?;
                if ob.asks[i].quantity == 0 {
                    ob.asks[i].is_active = 0;
                }
                remaining_qty = remaining_qty
                    .checked_sub(fill_qty)
                    .ok_or(MeridianError::InvalidAmount)?;
            }

            // Refund excess escrow (price improvement)
            let refund = escrow_amount
                .checked_sub(total_fill_cost)
                .ok_or(MeridianError::InvalidAmount)?
                .checked_sub(
                    remaining_qty
                        .checked_mul(price)
                        .ok_or(MeridianError::InvalidAmount)?,
                )
                .ok_or(MeridianError::InvalidAmount)?;

            if refund > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.ob_usdc_vault.to_account_info(),
                            to: ctx.accounts.user_usdc.to_account_info(),
                            authority: order_book_ai.clone(),
                        },
                        ob_signer_seeds,
                    ),
                    refund,
                )?;
            }

            // Compact asks: remove filled orders
            let ac = ob.ask_count;
            ob.ask_count = compact_orders(&mut ob.asks, ac);

            // Rest remaining quantity as a new bid
            if remaining_qty > 0 {
                let bid_count = ob.bid_count as usize;
                require!(bid_count < MAX_ORDERS_PER_SIDE, MeridianError::OrderBookFull);

                let order_id = ob.next_order_id;
                ob.next_order_id = order_id.checked_add(1).ok_or(MeridianError::InvalidAmount)?;

                // Find sorted insert position: bids descending by price, FIFO at same price
                let insert_pos = find_bid_insert_pos(&ob.bids, bid_count, price, order_id);

                // Shift orders right to make room
                for j in (insert_pos..bid_count).rev() {
                    ob.bids[j + 1] = ob.bids[j];
                }

                ob.bids[insert_pos] = Order {
                    owner: ctx.accounts.user.key(),
                    price,
                    quantity: remaining_qty,
                    timestamp: clock.unix_timestamp,
                    order_id,
                    is_active: 1,
                    _padding: [0; 7],
                };
                ob.bid_count = (bid_count + 1) as u16;
            }
        }
        OrderSide::Ask => {
            // Match against bids, highest price first (bids are sorted descending)
            let bid_count = ob.bid_count as usize;
            for i in 0..bid_count {
                if remaining_qty == 0 {
                    break;
                }
                if ob.bids[i].is_active == 0 {
                    continue;
                }
                let bid_price = ob.bids[i].price;
                if bid_price < price {
                    break; // bids are sorted descending, no more matches
                }

                let fill_qty = remaining_qty.min(ob.bids[i].quantity);
                let fill_cost = fill_qty
                    .checked_mul(bid_price)
                    .ok_or(MeridianError::InvalidAmount)?;

                // Transfer USDC from ob_usdc_vault to taker (user_usdc)
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.ob_usdc_vault.to_account_info(),
                            to: ctx.accounts.user_usdc.to_account_info(),
                            authority: order_book_ai.clone(),
                        },
                        ob_signer_seeds,
                    ),
                    fill_cost,
                )?;

                // Transfer Yes tokens from ob_yes_vault to counterparty (bid owner's Yes ATA)
                require!(
                    remaining_idx < ctx.remaining_accounts.len(),
                    MeridianError::InvalidAmount
                );
                let counterparty_yes = &ctx.remaining_accounts[remaining_idx];
                remaining_idx += 1;

                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.ob_yes_vault.to_account_info(),
                            to: counterparty_yes.to_account_info(),
                            authority: order_book_ai.clone(),
                        },
                        ob_signer_seeds,
                    ),
                    fill_qty,
                )?;

                ob.bids[i].quantity = ob.bids[i]
                    .quantity
                    .checked_sub(fill_qty)
                    .ok_or(MeridianError::InvalidAmount)?;
                if ob.bids[i].quantity == 0 {
                    ob.bids[i].is_active = 0;
                }
                remaining_qty = remaining_qty
                    .checked_sub(fill_qty)
                    .ok_or(MeridianError::InvalidAmount)?;
            }

            // Compact bids: remove filled orders
            let bc = ob.bid_count;
            ob.bid_count = compact_orders(&mut ob.bids, bc);

            // Rest remaining quantity as a new ask
            if remaining_qty > 0 {
                let ask_count = ob.ask_count as usize;
                require!(ask_count < MAX_ORDERS_PER_SIDE, MeridianError::OrderBookFull);

                let order_id = ob.next_order_id;
                ob.next_order_id = order_id.checked_add(1).ok_or(MeridianError::InvalidAmount)?;

                // Find sorted insert position: asks ascending by price, FIFO at same price
                let insert_pos = find_ask_insert_pos(&ob.asks, ask_count, price, order_id);

                // Shift orders right to make room
                for j in (insert_pos..ask_count).rev() {
                    ob.asks[j + 1] = ob.asks[j];
                }

                ob.asks[insert_pos] = Order {
                    owner: ctx.accounts.user.key(),
                    price,
                    quantity: remaining_qty,
                    timestamp: clock.unix_timestamp,
                    order_id,
                    is_active: 1,
                    _padding: [0; 7],
                };
                ob.ask_count = (ask_count + 1) as u16;
            }
        }
    }

    Ok(())
}

/// Remove inactive orders by shifting active ones left, then zeroing the tail.
/// Returns the new count.
fn compact_orders(orders: &mut [Order; MAX_ORDERS_PER_SIDE], count: u16) -> u16 {
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
    // Zero out vacated slots
    for i in write..n {
        orders[i] = Order::default();
    }
    write as u16
}

/// Find insert position for a bid (descending by price, FIFO at same price).
fn find_bid_insert_pos(
    bids: &[Order; MAX_ORDERS_PER_SIDE],
    count: usize,
    price: u64,
    order_id: u64,
) -> usize {
    for i in 0..count {
        if price > bids[i].price {
            return i;
        }
        if price == bids[i].price && order_id < bids[i].order_id {
            return i;
        }
    }
    count
}

/// Find insert position for an ask (ascending by price, FIFO at same price).
fn find_ask_insert_pos(
    asks: &[Order; MAX_ORDERS_PER_SIDE],
    count: usize,
    price: u64,
    order_id: u64,
) -> usize {
    for i in 0..count {
        if price < asks[i].price {
            return i;
        }
        if price == asks[i].price && order_id < asks[i].order_id {
            return i;
        }
    }
    count
}
