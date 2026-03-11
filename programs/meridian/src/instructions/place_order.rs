use crate::errors::MeridianError;
use crate::instructions::shared::validate_order_book_for_market;
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

    // --- Validation ---
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    ctx.accounts.market.assert_trading_active()?;
    require!(
        price > 0 && price < USDC_PER_PAIR,
        MeridianError::InvalidPrice
    );
    require!(quantity > 0, MeridianError::InvalidAmount);

    // `place_order` is intentionally maker-only. Crossing/taker behavior belongs
    // to the dedicated Buy Yes / Sell Yes / Buy No / Sell No instructions.
    {
        let ob = ctx.accounts.order_book.load()?;

        validate_order_book_for_market(
            &ob,
            &market_key,
            ctx.accounts.ob_usdc_vault.key(),
            ctx.accounts.ob_yes_vault.key(),
        )?;
        validate_maker_only(side, price, &ob)?;
    }

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

    {
        let mut ob = ctx.accounts.order_book.load_mut()?;
        let clock = Clock::get()?;

        match side {
            OrderSide::Bid => {
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
                    quantity,
                    timestamp: clock.unix_timestamp,
                    order_id,
                    is_active: 1,
                    _padding: [0; 7],
                };
                ob.bid_count = (bid_count + 1) as u16;
            }
            OrderSide::Ask => {
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
                    quantity,
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

fn validate_maker_only(side: OrderSide, price: u64, order_book: &OrderBook) -> Result<()> {
    match side {
        OrderSide::Bid => {
            let best_ask = order_book
                .asks
                .iter()
                .take(order_book.ask_count as usize)
                .find(|order| order.is_active != 0);
            if let Some(best_ask) = best_ask {
                require!(
                    price < best_ask.price,
                    MeridianError::CrossingOrdersUseDedicatedPath
                );
            }
        }
        OrderSide::Ask => {
            let best_bid = order_book
                .bids
                .iter()
                .take(order_book.bid_count as usize)
                .find(|order| order.is_active != 0);
            if let Some(best_bid) = best_bid {
                require!(
                    price > best_bid.price,
                    MeridianError::CrossingOrdersUseDedicatedPath
                );
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(price: u64, order_id: u64, active: bool) -> Order {
        Order {
            owner: Pubkey::new_unique(),
            price,
            quantity: 1,
            timestamp: 0,
            order_id,
            is_active: u8::from(active),
            _padding: [0; 7],
        }
    }

    fn empty_book() -> OrderBook {
        OrderBook {
            market: Pubkey::new_unique(),
            ob_usdc_vault: Pubkey::new_unique(),
            ob_yes_vault: Pubkey::new_unique(),
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
    fn maker_only_allows_resting_bid_below_best_ask() {
        let mut order_book = empty_book();
        order_book.asks[0] = order(600_000, 1, true);
        order_book.ask_count = 1;

        validate_maker_only(OrderSide::Bid, 599_999, &order_book).unwrap();
    }

    #[test]
    fn maker_only_rejects_bid_crossing_best_ask() {
        let mut order_book = empty_book();
        order_book.asks[0] = order(600_000, 1, true);
        order_book.ask_count = 1;

        let err = validate_maker_only(OrderSide::Bid, 600_000, &order_book).unwrap_err();
        assert!(err.to_string().contains("CrossingOrdersUseDedicatedPath"));
    }

    #[test]
    fn maker_only_allows_resting_ask_above_best_bid() {
        let mut order_book = empty_book();
        order_book.bids[0] = order(400_000, 1, true);
        order_book.bid_count = 1;

        validate_maker_only(OrderSide::Ask, 400_001, &order_book).unwrap();
    }

    #[test]
    fn maker_only_rejects_ask_crossing_best_bid() {
        let mut order_book = empty_book();
        order_book.bids[0] = order(400_000, 1, true);
        order_book.bid_count = 1;

        let err = validate_maker_only(OrderSide::Ask, 400_000, &order_book).unwrap_err();
        assert!(err.to_string().contains("CrossingOrdersUseDedicatedPath"));
    }

    #[test]
    fn bid_insert_position_preserves_fifo_at_equal_price() {
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(650_000, 1, true);
        bids[1] = order(650_000, 2, true);

        let insert_pos = find_bid_insert_pos(&bids, 2, 650_000, 3);
        assert_eq!(insert_pos, 2);
    }

    #[test]
    fn bid_insert_position_moves_ahead_for_better_price() {
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(650_000, 1, true);
        bids[1] = order(640_000, 2, true);

        let insert_pos = find_bid_insert_pos(&bids, 2, 660_000, 3);
        assert_eq!(insert_pos, 0);
    }

    #[test]
    fn ask_insert_position_preserves_fifo_at_equal_price() {
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(350_000, 1, true);
        asks[1] = order(350_000, 2, true);

        let insert_pos = find_ask_insert_pos(&asks, 2, 350_000, 3);
        assert_eq!(insert_pos, 2);
    }

    #[test]
    fn ask_insert_position_moves_ahead_for_better_price() {
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(350_000, 1, true);
        asks[1] = order(360_000, 2, true);

        let insert_pos = find_ask_insert_pos(&asks, 2, 340_000, 3);
        assert_eq!(insert_pos, 0);
    }
}
