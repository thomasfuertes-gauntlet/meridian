// KEY-DECISION 2026-03-16: Temporary instruction for nuking pre-migration markets
// whose OrderBook accounts are undersized (4728 vs 7800 bytes). Skips settlement
// check and OB deserialization. Remove after devnet cleanup.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{GlobalConfig, StrikeMarket};

#[derive(Accounts)]
pub struct ForceCloseMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ MeridianError::Unauthorized,
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        close = admin,
        seeds = [
            StrikeMarket::SEED,
            market.ticker.as_bytes(),
            &market.strike_price.to_le_bytes(),
            &market.date.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, StrikeMarket>,

    /// CHECK: Validated by key match to market.order_book in handler.
    /// Raw account - no deserialization. Tolerates any OB layout size.
    #[account(mut)]
    pub order_book: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ForceCloseMarket>) -> Result<()> {
    let market = &ctx.accounts.market;

    // Validate order book belongs to this market
    require!(
        ctx.accounts.order_book.key() == market.order_book,
        MeridianError::InvalidOrderBookAccount
    );

    // Close the OrderBook account - return rent to admin
    let ob_info = ctx.accounts.order_book.to_account_info();
    let admin_info = ctx.accounts.admin.to_account_info();

    let ob_lamports = ob_info.lamports();
    **ob_info.try_borrow_mut_lamports()? = 0;
    **admin_info.try_borrow_mut_lamports()? = admin_info
        .lamports()
        .checked_add(ob_lamports)
        .ok_or(MeridianError::InvalidAmount)?;

    ob_info.assign(&anchor_lang::system_program::ID);
    ob_info.resize(0)?;

    // Market account closed via Anchor's `close = admin` attribute
    Ok(())
}
