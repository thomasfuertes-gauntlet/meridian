use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::{GlobalConfig, MarketOutcome, MarketStatus, StrikeMarket};

#[derive(Accounts)]
pub struct AdminSettle<'info> {
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

pub fn handler(ctx: Context<AdminSettle>, price: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(!market.is_settled(), MeridianError::MarketAlreadySettled);

    let clock = Clock::get()?;
    // Admin settle is the fallback path and requires a configured delay.
    require!(
        clock.unix_timestamp >= market.close_time + ctx.accounts.config.admin_settle_delay_secs,
        MeridianError::AdminSettleTooEarly
    );

    let outcome = if price >= market.strike_price {
        MarketOutcome::YesWins
    } else {
        MarketOutcome::NoWins
    };

    let market = &mut ctx.accounts.market;
    if market.status == MarketStatus::Created {
        market.status = MarketStatus::Frozen;
        market.frozen_at = Some(clock.unix_timestamp);
    }
    require!(
        market.status == MarketStatus::Frozen,
        MeridianError::InvalidMarketState
    );
    market.status = MarketStatus::Settled;
    market.outcome = outcome;
    market.settled_at = Some(clock.unix_timestamp);

    Ok(())
}
