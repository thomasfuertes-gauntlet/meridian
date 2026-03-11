use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
use crate::instructions::shared::{assert_market_vault_invariant, burn_complete_set_for_usdc};
use crate::state::{StrikeMarket, USDC_PER_PAIR};

#[derive(Accounts)]
pub struct BurnPair<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

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
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(mut)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = market.yes_mint,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = market.no_mint,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BurnPair>, amount: u64) -> Result<()> {
    require!(amount > 0, MeridianError::InvalidAmount);

    let market = &ctx.accounts.market;
    let market_seeds = &[
        StrikeMarket::SEED,
        market.ticker.as_bytes(),
        &market.strike_price.to_le_bytes(),
        &market.date.to_le_bytes(),
        &[market.bump],
    ];
    let signer_seeds = &[&market_seeds[..]];

    // `burn_pair` remains a paired exit path both before and after settlement as
    // long as the caller still holds one Yes and one No for each unit burned.
    burn_complete_set_for_usdc(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.yes_mint.to_account_info(),
        ctx.accounts.no_mint.to_account_info(),
        ctx.accounts.user_yes.to_account_info(),
        ctx.accounts.user_no.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.user_usdc.to_account_info(),
        signer_seeds,
        amount,
        USDC_PER_PAIR,
    )?;

    let market = &mut ctx.accounts.market;
    // Burning a complete Yes+No pair removes one fully collateralized claim from
    // the vault for each unit burned.
    market.consume_open_interest(amount)?;

    ctx.accounts.vault.reload()?;
    assert_market_vault_invariant(market, ctx.accounts.vault.amount, USDC_PER_PAIR)?;

    Ok(())
}
