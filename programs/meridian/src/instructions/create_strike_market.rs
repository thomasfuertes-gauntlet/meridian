use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
use crate::state::{GlobalConfig, MarketOutcome, StrikeMarket};

#[derive(Accounts)]
#[instruction(ticker: String, strike_price: u64, date: i64)]
pub struct CreateStrikeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = admin,
        space = StrikeMarket::SPACE,
        seeds = [
            StrikeMarket::SEED,
            ticker.as_bytes(),
            &strike_price.to_le_bytes(),
            &date.to_le_bytes(),
        ],
        bump,
    )]
    pub market: Account<'info, StrikeMarket>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 0,
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 0,
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump,
    )]
    pub no_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreateStrikeMarket>,
    ticker: String,
    strike_price: u64,
    date: i64,
    close_time: i64,
    pyth_feed_id: [u8; 32],
) -> Result<()> {
    require!(
        !ticker.is_empty() && ticker.len() <= StrikeMarket::MAX_TICKER_LEN,
        MeridianError::InvalidTicker
    );

    let market = &mut ctx.accounts.market;
    market.ticker = ticker;
    market.strike_price = strike_price;
    market.date = date;
    market.outcome = MarketOutcome::Pending;
    market.total_pairs_minted = 0;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.admin = ctx.accounts.admin.key();
    market.bump = ctx.bumps.market;
    market.settled_at = None;
    market.close_time = close_time;
    market.pyth_feed_id = pyth_feed_id;

    Ok(())
}
