use anchor_lang::prelude::*;

use crate::state::{GlobalConfig, MarketStatus, StrikeMarket};

#[derive(Accounts)]
pub struct FreezeMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

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
}

pub fn handler(ctx: Context<FreezeMarket>) -> Result<()> {
    let clock = Clock::get()?;
    let market = &mut ctx.accounts.market;
    market.assert_can_freeze(clock.unix_timestamp)?;

    market.status = MarketStatus::Frozen;
    market.frozen_at = Some(clock.unix_timestamp);

    Ok(())
}
