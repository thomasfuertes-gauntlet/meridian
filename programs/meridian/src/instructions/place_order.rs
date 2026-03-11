use crate::errors::MeridianError;
use crate::instructions::shared::{
    apply_fills_to_orders, validate_counterparty_token_account, validate_order_book_for_market,
    AtomicFill,
};
use crate::state::{
    GlobalConfig, Order, OrderBook, OrderSide, StrikeMarket, MAX_ORDERS_PER_SIDE, USDC_PER_PAIR,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

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

    #[account(
        mut,
        token::mint = market.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = market.yes_mint,
        token::authority = user,
    )]
    pub user_yes: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
    side: OrderSide,
    price: u64,
    quantity: u64,
) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let order_book_ai = ctx.accounts.order_book.to_account_info();

    // --- Validation ---
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    ctx.accounts.market.assert_trading_active()?;
    require!(
        price > 0 && price < USDC_PER_PAIR,
        MeridianError::InvalidPrice
    );
    require!(quantity > 0, MeridianError::InvalidAmount);

    // --- Escrow incoming tokens (before any AccountLoader borrow) ---
    let escrow_amount = match side {
        OrderSide::Bid => quantity
            .checked_mul(price)
            .ok_or(MeridianError::InvalidAmount)?,
        OrderSide::Ask => quantity,
    };

    match side {
        OrderSide::Bid => {
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

    // --- Phase 1: READ - compute matches without CPI ---
    let (fills, remaining_qty, total_fill_cost, ob_bump) = {
        let ob = ctx.accounts.order_book.load()?;

        validate_order_book_for_market(
            &ob,
            &market_key,
            ctx.accounts.ob_usdc_vault.key(),
            ctx.accounts.ob_yes_vault.key(),
        )?;

        let mut fills: Vec<AtomicFill> = Vec::new();
        let mut rem_qty = quantity;
        let mut total_cost: u64 = 0;
        let mut ra_idx: usize = 0;

        match side {
            OrderSide::Bid => {
                let ask_count = ob.ask_count as usize;
                for i in 0..ask_count {
                    if rem_qty == 0 {
                        break;
                    }
                    if ob.asks[i].is_active == 0 {
                        continue;
                    }
                    let ask_price = ob.asks[i].price;
                    if ask_price > price {
                        break;
                    }

                    let fill_qty = rem_qty.min(ob.asks[i].quantity);
                    let fill_cost = fill_qty
                        .checked_mul(ask_price)
                        .ok_or(MeridianError::InvalidAmount)?;
                    total_cost = total_cost
                        .checked_add(fill_cost)
                        .ok_or(MeridianError::InvalidAmount)?;

                    fills.push(AtomicFill {
                        book_index: i,
                        fill_qty,
                        fill_cost,
                        remaining_acct_idx: ra_idx,
                        counterparty_owner: ob.asks[i].owner,
                    });
                    ra_idx += 1;
                    rem_qty = rem_qty
                        .checked_sub(fill_qty)
                        .ok_or(MeridianError::InvalidAmount)?;
                }
            }
            OrderSide::Ask => {
                let bid_count = ob.bid_count as usize;
                for i in 0..bid_count {
                    if rem_qty == 0 {
                        break;
                    }
                    if ob.bids[i].is_active == 0 {
                        continue;
                    }
                    let bid_price = ob.bids[i].price;
                    if bid_price < price {
                        break;
                    }

                    let fill_qty = rem_qty.min(ob.bids[i].quantity);
                    let fill_cost = fill_qty
                        .checked_mul(bid_price)
                        .ok_or(MeridianError::InvalidAmount)?;

                    fills.push(AtomicFill {
                        book_index: i,
                        fill_qty,
                        fill_cost,
                        remaining_acct_idx: ra_idx,
                        counterparty_owner: ob.bids[i].owner,
                    });
                    ra_idx += 1;
                    rem_qty = rem_qty
                        .checked_sub(fill_qty)
                        .ok_or(MeridianError::InvalidAmount)?;
                }
            }
        }

        (fills, rem_qty, total_cost, ob.bump)
    };
    // ob read borrow dropped here

    // --- Phase 2: CPI - execute all fill transfers ---
    let ob_seeds: &[&[u8]] = &[OrderBook::SEED, market_key.as_ref(), &[ob_bump]];
    let ob_signer_seeds = &[ob_seeds];

    for fill in &fills {
        require!(
            fill.remaining_acct_idx < ctx.remaining_accounts.len(),
            MeridianError::MissingCounterpartyAccount
        );
        let counterparty_ata = &ctx.remaining_accounts[fill.remaining_acct_idx];
        let counterparty_token_account = Account::<TokenAccount>::try_from(counterparty_ata)
            .map_err(|_| MeridianError::InvalidCounterpartyAccount)?;

        match side {
            OrderSide::Bid => {
                validate_counterparty_token_account(
                    &counterparty_token_account,
                    fill.counterparty_owner,
                    ctx.accounts.ob_usdc_vault.mint,
                )?;
                // Taker gets Yes tokens
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
                    fill.fill_qty,
                )?;
                // Ask owner gets USDC
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.ob_usdc_vault.to_account_info(),
                            to: counterparty_ata.to_account_info(),
                            authority: order_book_ai.clone(),
                        },
                        ob_signer_seeds,
                    ),
                    fill.fill_cost,
                )?;
            }
            OrderSide::Ask => {
                validate_counterparty_token_account(
                    &counterparty_token_account,
                    fill.counterparty_owner,
                    ctx.accounts.ob_yes_vault.mint,
                )?;
                // Taker gets USDC
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
                    fill.fill_cost,
                )?;
                // Bid owner gets Yes tokens
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.ob_yes_vault.to_account_info(),
                            to: counterparty_ata.to_account_info(),
                            authority: order_book_ai.clone(),
                        },
                        ob_signer_seeds,
                    ),
                    fill.fill_qty,
                )?;
            }
        }
    }

    // Refund excess escrow for bids (price improvement)
    if side == OrderSide::Bid {
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
    }

    // --- Phase 3: WRITE - update book state ---
    {
        let mut ob = ctx.accounts.order_book.load_mut()?;
        let clock = Clock::get()?;

        match side {
            OrderSide::Bid => {
                // Update matched asks
                let ac = ob.ask_count;
                ob.ask_count = apply_fills_to_orders(&mut ob.asks, ac, &fills)?;

                // Rest remaining quantity as a new bid
                if remaining_qty > 0 {
                    let bid_count = ob.bid_count as usize;
                    require!(
                        bid_count < MAX_ORDERS_PER_SIDE,
                        MeridianError::OrderBookFull
                    );

                    let order_id = ob.next_order_id;
                    ob.next_order_id = order_id
                        .checked_add(1)
                        .ok_or(MeridianError::InvalidAmount)?;

                    let insert_pos = find_bid_insert_pos(&ob.bids, bid_count, price, order_id);
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
                // Update matched bids
                let bc = ob.bid_count;
                ob.bid_count = apply_fills_to_orders(&mut ob.bids, bc, &fills)?;

                // Rest remaining quantity as a new ask
                if remaining_qty > 0 {
                    let ask_count = ob.ask_count as usize;
                    require!(
                        ask_count < MAX_ORDERS_PER_SIDE,
                        MeridianError::OrderBookFull
                    );

                    let order_id = ob.next_order_id;
                    ob.next_order_id = order_id
                        .checked_add(1)
                        .ok_or(MeridianError::InvalidAmount)?;

                    let insert_pos = find_ask_insert_pos(&ob.asks, ask_count, price, order_id);
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
    }

    Ok(())
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
