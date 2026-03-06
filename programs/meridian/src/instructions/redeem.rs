use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::state::{MarketOutcome, StrikeMarket, USDC_PER_PAIR};

#[derive(Accounts)]
pub struct Redeem<'info> {
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
        constraint = token_mint.key() == market.yes_mint || token_mint.key() == market.no_mint @ MeridianError::InvalidTokenMint,
    )]
    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user,
    )]
    pub user_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.market.outcome != MarketOutcome::Pending,
        MeridianError::MarketNotSettled
    );
    require!(amount > 0, MeridianError::InvalidAmount);

    let market = &ctx.accounts.market;
    let is_winner = (ctx.accounts.token_mint.key() == market.yes_mint
        && market.outcome == MarketOutcome::YesWins)
        || (ctx.accounts.token_mint.key() == market.no_mint
            && market.outcome == MarketOutcome::NoWins);

    // Burn the tokens being redeemed
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.token_mint.to_account_info(),
                from: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // If winner, transfer USDC from vault to user
    if is_winner {
        let market = &ctx.accounts.market;
        let market_seeds = &[
            StrikeMarket::SEED,
            market.ticker.as_bytes(),
            &market.strike_price.to_le_bytes(),
            &market.date.to_le_bytes(),
            &[market.bump],
        ];
        let signer_seeds = &[&market_seeds[..]];

        let usdc_amount = amount.checked_mul(USDC_PER_PAIR).unwrap();
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            usdc_amount,
        )?;

        let market = &mut ctx.accounts.market;
        market.total_pairs_minted = market.total_pairs_minted.checked_sub(amount).unwrap();
    }

    Ok(())
}
