use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{GlobalConfig, OrderBook, StrikeMarket};

#[derive(Accounts)]
pub struct CloseMarket<'info> {
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

    /// OrderBook to close. AccountLoader validates zero_copy discriminator.
    /// Key match to market.order_book validated in handler body.
    #[account(mut)]
    pub order_book: AccountLoader<'info, OrderBook>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CloseMarket>, force: bool) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(market.is_settled(), MeridianError::MarketNotSettled);

    // Validate order book belongs to this market
    require!(
        ctx.accounts.order_book.key() == market.order_book,
        MeridianError::InvalidOrderBookAccount
    );

    if !force {
        let ob = ctx.accounts.order_book.load()?;
        // Ensure all credits have been claimed
        let has_unclaimed = (0..ob.credit_count as usize)
            .any(|i| ob.credits[i].usdc_claimable > 0 || ob.credits[i].yes_claimable > 0);
        require!(!has_unclaimed, MeridianError::UnclaimedCredits);
    }

    // Close the OrderBook account manually - return rent to admin.
    // AccountLoader doesn't support Anchor's `close` attribute, so we do it here.
    let ob_info = ctx.accounts.order_book.to_account_info();
    let admin_info = ctx.accounts.admin.to_account_info();

    let ob_lamports = ob_info.lamports();
    **ob_info.try_borrow_mut_lamports()? = 0;
    **admin_info.try_borrow_mut_lamports()? = admin_info
        .lamports()
        .checked_add(ob_lamports)
        .ok_or(MeridianError::InvalidAmount)?;

    // Reassign to system program and zero data to mark as closed
    ob_info.assign(&anchor_lang::system_program::ID);
    ob_info.resize(0)?;

    // Market account is closed via Anchor's `close = admin` attribute
    Ok(())
}
