use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::state::{MarketOutcome, Order, OrderBook, StrikeMarket};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

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

    /// Refund destination - must be owned by the order owner
    #[account(mut)]
    pub refund_destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Whether the cancelled order was on the bid or ask side.
enum FoundSide {
    Bid,
    Ask,
}

pub fn handler(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
    // Capture market key before mutable borrow of order_book
    let market_key = ctx.accounts.market.key();

    // --- Phase 1: read order data and validate, then drop borrow ---
    let (side, index, refund_amount, owner, ob_bump) = {
        let ob = ctx.accounts.order_book.load()?;

        // Validate order_book belongs to this market
        require_keys_eq!(ob.market, market_key);

        // Search bids
        let bid_count = ob.bid_count as usize;
        let ask_count = ob.ask_count as usize;

        let mut found: Option<(FoundSide, usize)> = None;

        for i in 0..bid_count {
            if ob.bids[i].order_id == order_id && ob.bids[i].is_active == 1 {
                found = Some((FoundSide::Bid, i));
                break;
            }
        }

        if found.is_none() {
            for i in 0..ask_count {
                if ob.asks[i].order_id == order_id && ob.asks[i].is_active == 1 {
                    found = Some((FoundSide::Ask, i));
                    break;
                }
            }
        }

        let (side, idx) = found.ok_or(MeridianError::OrderNotFound)?;

        let order = match &side {
            FoundSide::Bid => &ob.bids[idx],
            FoundSide::Ask => &ob.asks[idx],
        };

        // Authorization: pending market requires owner == signer
        if ctx.accounts.market.outcome == MarketOutcome::Pending {
            require!(
                order.owner == ctx.accounts.user.key(),
                MeridianError::NotOrderOwner
            );
        }

        // Validate refund destination belongs to the order owner (prevents fund theft)
        require_keys_eq!(ctx.accounts.refund_destination.owner, order.owner);

        // Calculate refund amount
        let refund_amount = match &side {
            FoundSide::Bid => order
                .quantity
                .checked_mul(order.price)
                .ok_or(MeridianError::InvalidAmount)?,
            FoundSide::Ask => order.quantity,
        };

        let owner = order.owner;
        let bump = ob.bump;

        (side, idx, refund_amount, owner, bump)
    };
    // ob borrow dropped here

    // --- Phase 2: CPI transfer (no active borrow on order_book) ---
    let ob_seeds: &[&[u8]] = &[OrderBook::SEED, market_key.as_ref(), &[ob_bump]];
    let ob_signer = &[ob_seeds];

    let from_vault = match &side {
        FoundSide::Bid => ctx.accounts.ob_usdc_vault.to_account_info(),
        FoundSide::Ask => ctx.accounts.ob_yes_vault.to_account_info(),
    };

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: from_vault,
                to: ctx.accounts.refund_destination.to_account_info(),
                authority: ctx.accounts.order_book.to_account_info(),
            },
            ob_signer,
        ),
        refund_amount,
    )?;

    // --- Phase 3: re-borrow and compact the array ---
    {
        let mut ob = ctx.accounts.order_book.load_mut()?;

        match side {
            FoundSide::Bid => {
                let count = ob.bid_count as usize;
                for i in index..count - 1 {
                    ob.bids[i] = ob.bids[i + 1];
                }
                ob.bids[count - 1] = Order::default();
                ob.bid_count -= 1;
            }
            FoundSide::Ask => {
                let count = ob.ask_count as usize;
                for i in index..count - 1 {
                    ob.asks[i] = ob.asks[i + 1];
                }
                ob.asks[count - 1] = Order::default();
                ob.ask_count -= 1;
            }
        }
    }

    msg!(
        "Order {} cancelled. Refunded {} to {}",
        order_id,
        refund_amount,
        owner
    );

    Ok(())
}
