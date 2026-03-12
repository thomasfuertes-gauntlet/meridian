use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::instructions::shared::validate_order_book_for_market;
use crate::state::{OrderBook, StrikeMarket};

#[derive(Accounts)]
pub struct ClaimFills<'info> {
    /// Payer/signer. Permissionless - anyone can crank claims for any owner.
    #[account(mut)]
    pub payer: Signer<'info>,

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

    /// CHECK: The owner whose credits are being claimed. Not necessarily the signer.
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = owner_usdc.owner == owner.key() @ MeridianError::InvalidCounterpartyAccount,
        constraint = owner_usdc.mint == market.usdc_mint @ MeridianError::InvalidCollateralMint,
    )]
    pub owner_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = owner_yes.owner == owner.key() @ MeridianError::InvalidCounterpartyAccount,
        constraint = owner_yes.mint == market.yes_mint @ MeridianError::InvalidTokenMint,
    )]
    pub owner_yes: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// KEY-DECISION 2026-03-12: claim_fills is permissionless (any payer can crank for
// any owner) because credits are already earned - the maker's tokens are in the
// vault, just not yet transferred. This enables bots, UIs, or crankers to sweep
// credits without maker interaction. Works in any market state (Created, Frozen,
// Settled) since credits represent completed fills.

pub fn handler(ctx: Context<ClaimFills>) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let owner_key = ctx.accounts.owner.key();

    // Phase 1: Read credits + bump (don't zero yet - need CPI first)
    let (usdc_amount, yes_amount, ob_bump) = {
        let ob = ctx.accounts.order_book.load()?;

        validate_order_book_for_market(
            &ob,
            &market_key,
            ctx.accounts.ob_usdc_vault.key(),
            ctx.accounts.ob_yes_vault.key(),
        )?;

        let mut usdc = 0u64;
        let mut yes = 0u64;
        for i in 0..ob.credit_count as usize {
            if ob.credits[i].owner == owner_key {
                usdc = ob.credits[i].usdc_claimable;
                yes = ob.credits[i].yes_claimable;
                break;
            }
        }
        require!(usdc > 0 || yes > 0, MeridianError::NothingToClaim);
        (usdc, yes, ob.bump)
    };

    // Phase 2: CPI transfers from vaults to owner's ATAs
    let ob_seeds: &[&[u8]] = &[OrderBook::SEED, market_key.as_ref(), &[ob_bump]];
    let ob_signer = &[ob_seeds];

    if usdc_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.ob_usdc_vault.to_account_info(),
                    to: ctx.accounts.owner_usdc.to_account_info(),
                    authority: ctx.accounts.order_book.to_account_info(),
                },
                ob_signer,
            ),
            usdc_amount,
        )?;
    }

    if yes_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.ob_yes_vault.to_account_info(),
                    to: ctx.accounts.owner_yes.to_account_info(),
                    authority: ctx.accounts.order_book.to_account_info(),
                },
                ob_signer,
            ),
            yes_amount,
        )?;
    }

    // Phase 3: Zero the credit entry
    {
        let mut ob = ctx.accounts.order_book.load_mut()?;
        ob.take_credits(&owner_key)?;
    }

    msg!(
        "Claimed {} USDC + {} Yes for {}",
        usdc_amount,
        yes_amount,
        owner_key,
    );

    Ok(())
}
