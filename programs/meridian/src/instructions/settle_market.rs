use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{GlobalConfig, MarketOutcome, StrikeMarket};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
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

pub fn handler(ctx: Context<SettleMarket>, outcome: MarketOutcome) -> Result<()> {
    require!(
        ctx.accounts.market.outcome == MarketOutcome::Pending,
        MeridianError::MarketAlreadySettled
    );
    require!(
        outcome != MarketOutcome::Pending,
        MeridianError::InvalidOutcome
    );

    let market = &mut ctx.accounts.market;
    market.outcome = outcome;
    market.settled_at = Some(Clock::get()?.unix_timestamp);

    Ok(())
}
