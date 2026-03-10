use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::{GlobalConfig, StrikeMarket, OrderBook, MarketOutcome};
use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct InitializeOrderBook<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
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
        constraint = market.outcome == MarketOutcome::Pending @ MeridianError::MarketAlreadySettled,
    )]
    pub market: Account<'info, StrikeMarket>,

    #[account(
        init,
        payer = admin,
        space = OrderBook::SPACE,
        seeds = [OrderBook::SEED, market.key().as_ref()],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    /// The market's yes_mint (for the ask escrow vault)
    #[account(
        address = market.yes_mint,
    )]
    pub yes_mint: Account<'info, Mint>,

    /// USDC mint (for the bid escrow vault)
    #[account(
        address = market.usdc_mint @ MeridianError::InvalidCollateralMint,
    )]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = order_book,
        seeds = [b"ob_usdc_vault", market.key().as_ref()],
        bump,
    )]
    pub ob_usdc_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        token::mint = yes_mint,
        token::authority = order_book,
        seeds = [b"ob_yes_vault", market.key().as_ref()],
        bump,
    )]
    pub ob_yes_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeOrderBook>) -> Result<()> {
    let mut order_book = ctx.accounts.order_book.load_init()?;
    order_book.market = ctx.accounts.market.key();
    order_book.ob_usdc_vault = ctx.accounts.ob_usdc_vault.key();
    order_book.ob_yes_vault = ctx.accounts.ob_yes_vault.key();
    order_book.next_order_id = 1;
    order_book.bid_count = 0;
    order_book.ask_count = 0;
    order_book.bump = ctx.bumps.order_book;
    Ok(())
}
