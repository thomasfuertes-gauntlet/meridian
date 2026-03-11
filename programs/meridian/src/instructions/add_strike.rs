use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
use crate::state::{GlobalConfig, MarketOutcome, MarketStatus, OrderBook, StrikeMarket};

#[derive(Accounts)]
#[instruction(ticker: String, strike_price: u64, date: i64)]
pub struct AddStrike<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

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
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 0,
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 0,
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        space = OrderBook::SPACE,
        seeds = [OrderBook::SEED, market.key().as_ref()],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = order_book,
        seeds = [b"ob_usdc_vault", market.key().as_ref()],
        bump,
    )]
    pub ob_usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        token::mint = yes_mint,
        token::authority = order_book,
        seeds = [b"ob_yes_vault", market.key().as_ref()],
        bump,
    )]
    pub ob_yes_vault: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<AddStrike>,
    ticker: String,
    strike_price: u64,
    date: i64,
    close_time: i64,
) -> Result<()> {
    require!(
        !ticker.is_empty() && ticker.len() <= StrikeMarket::MAX_TICKER_LEN,
        MeridianError::InvalidTicker
    );
    ctx.accounts.config.oracle_policy_for_ticker(&ticker)?;
    require!(strike_price > 0, MeridianError::InvalidAmount);
    require!(close_time > date, MeridianError::InvalidCloseTime);

    let market = &mut ctx.accounts.market;
    market.ticker = ticker;
    market.strike_price = strike_price;
    market.date = date;
    market.status = MarketStatus::Created;
    market.outcome = MarketOutcome::Pending;
    market.total_pairs_minted = 0;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.usdc_mint = ctx.accounts.usdc_mint.key();
    market.order_book = ctx.accounts.order_book.key();
    market.ob_usdc_vault = ctx.accounts.ob_usdc_vault.key();
    market.ob_yes_vault = ctx.accounts.ob_yes_vault.key();
    market.admin = ctx.accounts.admin.key();
    market.bump = ctx.bumps.market;
    market.frozen_at = None;
    market.settled_at = None;
    market.settlement_price = None;
    market.settlement_source = None;
    market.close_time = close_time;

    let mut order_book = ctx.accounts.order_book.load_init()?;
    order_book.market = market.key();
    order_book.ob_usdc_vault = ctx.accounts.ob_usdc_vault.key();
    order_book.ob_yes_vault = ctx.accounts.ob_yes_vault.key();
    order_book.next_order_id = 1;
    order_book.bid_count = 0;
    order_book.ask_count = 0;
    order_book.bump = ctx.bumps.order_book;

    Ok(())
}
