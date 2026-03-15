use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::instructions::shared::{assert_market_vault_invariant, burn_complete_set_for_usdc};
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

    #[account(
        mut,
        token::mint = market.usdc_mint,
        token::authority = user,
    )]
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

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, MeridianError::InvalidAmount);

    if !ctx.accounts.market.is_settled() {
        return handle_unsettled_pair_redeem(ctx, amount);
    }

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

        let usdc_amount = amount
            .checked_mul(USDC_PER_PAIR)
            .ok_or(MeridianError::InvalidAmount)?;
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
        // Winning redemption consumes one remaining collateralized claim per
        // token redeemed, so open interest drops with the vault payout.
        market.consume_open_interest(amount)?;
    } else {
        // Losing redemption is only token cleanup. The vault still backs the
        // surviving winning claims, so open interest must not change here.
    }

    // Burning either winning or losing tokens must leave vault accounting
    // coherent relative to the surviving paired claims.
    ctx.accounts.vault.reload()?;
    assert_market_vault_invariant(
        &ctx.accounts.market,
        ctx.accounts.vault.amount,
        USDC_PER_PAIR,
    )?;

    Ok(())
}

fn handle_unsettled_pair_redeem<'info>(
    ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>,
    amount: u64,
) -> Result<()> {
    require!(
        ctx.accounts.market.outcome == MarketOutcome::Pending,
        MeridianError::InvalidMarketState
    );
    require!(
        ctx.remaining_accounts.len() >= 2,
        MeridianError::MissingCounterpartyAccount
    );

    let counterpart_mint = Account::<Mint>::try_from(&ctx.remaining_accounts[0])
        .map_err(|_| error!(MeridianError::InvalidTokenMint))?;
    let counterpart_user_token = Account::<TokenAccount>::try_from(&ctx.remaining_accounts[1])
        .map_err(|_| error!(MeridianError::InvalidCounterpartyAccount))?;

    let market = &ctx.accounts.market;
    let primary_is_yes = ctx.accounts.token_mint.key() == market.yes_mint;
    let expected_counterpart_mint = if primary_is_yes {
        market.no_mint
    } else if ctx.accounts.token_mint.key() == market.no_mint {
        market.yes_mint
    } else {
        return err!(MeridianError::InvalidTokenMint);
    };

    require_keys_eq!(
        counterpart_mint.key(),
        expected_counterpart_mint,
        MeridianError::InvalidTokenMint
    );
    require_keys_eq!(
        counterpart_user_token.owner,
        ctx.accounts.user.key(),
        MeridianError::InvalidCounterpartyAccount
    );
    require_keys_eq!(
        counterpart_user_token.mint,
        expected_counterpart_mint,
        MeridianError::InvalidCounterpartyAccount
    );

    let market_seeds = &[
        StrikeMarket::SEED,
        market.ticker.as_bytes(),
        &market.strike_price.to_le_bytes(),
        &market.date.to_le_bytes(),
        &[market.bump],
    ];
    let signer_seeds = &[&market_seeds[..]];

    let (yes_mint, no_mint, user_yes, user_no) = if primary_is_yes {
        (
            ctx.accounts.token_mint.to_account_info(),
            counterpart_mint.to_account_info(),
            ctx.accounts.user_token.to_account_info(),
            counterpart_user_token.to_account_info(),
        )
    } else {
        (
            counterpart_mint.to_account_info(),
            ctx.accounts.token_mint.to_account_info(),
            counterpart_user_token.to_account_info(),
            ctx.accounts.user_token.to_account_info(),
        )
    };

    burn_complete_set_for_usdc(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.market.to_account_info(),
        yes_mint,
        no_mint,
        user_yes,
        user_no,
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.user_usdc.to_account_info(),
        signer_seeds,
        amount,
        USDC_PER_PAIR,
    )?;

    let market = &mut ctx.accounts.market;
    market.consume_open_interest(amount)?;

    ctx.accounts.vault.reload()?;
    assert_market_vault_invariant(
        &ctx.accounts.market,
        ctx.accounts.vault.amount,
        USDC_PER_PAIR,
    )?;

    Ok(())
}
