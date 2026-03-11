use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::errors::MeridianError;
use crate::instructions::shared::{
    apply_fills_to_orders, assert_market_vault_invariant, escrow_yes, mint_complete_set,
    plan_bid_fills, sell_yes_into_bids, validate_order_book_for_market,
};
use crate::state::{
    GlobalConfig, Order, OrderBook, StrikeMarket, MAX_ORDERS_PER_SIDE, USDC_PER_PAIR,
};

#[derive(Accounts)]
pub struct BuyNo<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [
            StrikeMarket::SEED,
            market.ticker.as_bytes(),
            &market.strike_price.to_le_bytes(),
            &market.date.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, StrikeMarket>,

    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"no_mint", market.key().as_ref()],
        bump,
    )]
    pub no_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = no_mint,
        associated_token::authority = user,
    )]
    pub user_no: Account<'info, TokenAccount>,

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

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, BuyNo<'info>>,
    amount: u64,
    min_price: u64,
) -> Result<()> {
    require!(amount > 0, MeridianError::InvalidAmount);
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    ctx.accounts.market.assert_trading_active()?;
    require!(
        min_price > 0 && min_price < USDC_PER_PAIR,
        MeridianError::InvalidPrice
    );

    let market_key = ctx.accounts.market.key();
    let market = &ctx.accounts.market;
    let market_seeds = &[
        StrikeMarket::SEED,
        market.ticker.as_bytes(),
        &market.strike_price.to_le_bytes(),
        &market.date.to_le_bytes(),
        &[market.bump],
    ];
    let market_signer = &[&market_seeds[..]];

    // 1. Mint the pair against fresh USDC collateral.
    mint_complete_set(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.user_usdc.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.yes_mint.to_account_info(),
        ctx.accounts.no_mint.to_account_info(),
        ctx.accounts.user_yes.to_account_info(),
        ctx.accounts.user_no.to_account_info(),
        market_signer,
        amount,
        USDC_PER_PAIR,
    )?;

    // 2. Escrow the freshly minted Yes into the order book.
    escrow_yes(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.user_yes.to_account_info(),
        ctx.accounts.ob_yes_vault.to_account_info(),
        amount,
    )?;

    // 3. Compute matches against resting bids. This must fully fill.
    let (fills, ob_bump) = {
        let ob = ctx.accounts.order_book.load()?;

        validate_order_book_for_market(
            &ob,
            &market_key,
            ctx.accounts.ob_usdc_vault.key(),
            ctx.accounts.ob_yes_vault.key(),
        )?;

        let fills = plan_bid_fills(&ob.bids, ob.bid_count as usize, amount, min_price)?;

        (fills, ob.bump)
    };

    // 4. Execute transfers.
    let order_book_ai = ctx.accounts.order_book.to_account_info();
    let ob_seeds: &[&[u8]] = &[OrderBook::SEED, market_key.as_ref(), &[ob_bump]];
    let ob_signer = &[ob_seeds];
    sell_yes_into_bids(
        ctx.accounts.token_program.to_account_info(),
        order_book_ai,
        ctx.accounts.user_usdc.to_account_info(),
        &ctx.accounts.ob_usdc_vault,
        &ctx.accounts.ob_yes_vault,
        ob_signer,
        &fills,
        ctx.remaining_accounts,
    )?;

    // 5. Update the resting bid book and market collateral accounting.
    {
        let mut ob = ctx.accounts.order_book.load_mut()?;
        let bid_count = ob.bid_count;
        ob.bid_count = apply_fills_to_orders(&mut ob.bids, bid_count, &fills)?;
    }

    let market = &mut ctx.accounts.market;
    market.increase_open_interest(amount)?;

    ctx.accounts.vault.reload()?;
    assert_market_vault_invariant(market, ctx.accounts.vault.amount, USDC_PER_PAIR)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(price: u64, quantity: u64, active: bool) -> Order {
        Order {
            owner: Pubkey::new_unique(),
            price,
            quantity,
            timestamp: 0,
            order_id: 1,
            is_active: u8::from(active),
            _padding: [0; 7],
        }
    }

    #[test]
    fn buy_no_matches_multiple_bids_for_full_fill() {
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(650_000, 2, true);
        bids[1] = order(600_000, 1, true);

        let fills = plan_bid_fills(&bids, 2, 3, 550_000).unwrap();
        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0].fill_qty, 2);
        assert_eq!(fills[1].fill_qty, 1);
    }

    #[test]
    fn buy_no_rejects_partial_fill() {
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(650_000, 1, true);

        let err = plan_bid_fills(&bids, 1, 2, 600_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }

    #[test]
    fn buy_no_rejects_bids_below_min_price() {
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(500_000, 3, true);

        let err = plan_bid_fills(&bids, 1, 1, 600_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }
}
