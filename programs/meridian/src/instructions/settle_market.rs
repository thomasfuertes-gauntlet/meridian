use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::MeridianError;
use crate::state::{MarketOutcome, StrikeMarket};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,

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

    pub price_update: Account<'info, PriceUpdateV2>,
}

pub fn handler(ctx: Context<SettleMarket>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(
        market.outcome == MarketOutcome::Pending,
        MeridianError::MarketAlreadySettled
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= market.close_time,
        MeridianError::SettlementTooEarly
    );

    // Read price from Pyth - max 300 seconds (5 minutes) staleness
    let price = ctx
        .accounts
        .price_update
        .get_price_no_older_than(&clock, 300, &market.pyth_feed_id)
        .map_err(|_| MeridianError::PriceStale)?;

    // Confidence check: conf must be < 1% of price
    let price_abs = price.price.unsigned_abs();
    require!(
        price.conf.checked_mul(100).unwrap_or(u64::MAX) <= price_abs,
        MeridianError::PriceConfidenceTooWide
    );

    // Convert Pyth price to USDC base units (6 decimals).
    // Pyth price = price.price * 10^price.exponent
    // We want the price in units of 10^-6 (USDC micro-units).
    let target_exp: i32 = -6;
    let exp_diff = price.exponent - target_exp;

    let oracle_price_usdc: u64 = if exp_diff >= 0 {
        (price.price as u64)
            .checked_mul(10u64.pow(exp_diff as u32))
            .unwrap()
    } else {
        (price.price as u64) / 10u64.pow((-exp_diff) as u32)
    };

    // Settlement: at-or-above rule
    let outcome = if oracle_price_usdc >= market.strike_price {
        MarketOutcome::YesWins
    } else {
        MarketOutcome::NoWins
    };

    let market = &mut ctx.accounts.market;
    market.outcome = outcome;
    market.settled_at = Some(clock.unix_timestamp);

    Ok(())
}
