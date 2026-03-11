use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::instructions::shared::validate_order_book_drained;
use crate::state::{GlobalConfig, MarketOutcome, StrikeMarket};

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

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, AdminSettle<'info>>,
    price: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let market_key = ctx.accounts.market.key();
    let clock = Clock::get()?;
    market.assert_can_settle(clock.unix_timestamp)?;
    // Admin settle is the fallback path and requires a configured delay.
    validate_admin_settle_delay(
        market.close_time,
        ctx.accounts.config.admin_settle_delay_secs,
        clock.unix_timestamp,
    )?;
    validate_admin_settlement_price(price)?;
    validate_order_book_drained(market, &market_key, ctx.remaining_accounts)?;

    let outcome = if price >= market.strike_price {
        MarketOutcome::YesWins
    } else {
        MarketOutcome::NoWins
    };

    let market = &mut ctx.accounts.market;
    market.apply_admin_settlement(outcome, price, clock.unix_timestamp)?;

    Ok(())
}

fn validate_admin_settle_delay(close_time: i64, delay_secs: i64, now: i64) -> Result<()> {
    require!(
        now >= close_time + delay_secs,
        MeridianError::AdminSettleTooEarly
    );
    Ok(())
}

fn validate_admin_settlement_price(price: u64) -> Result<()> {
    require!(price > 0, MeridianError::InvalidSettlementPrice);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_admin_settle_before_delay() {
        let err = validate_admin_settle_delay(1_000, 3_600, 4_599).unwrap_err();
        assert!(err.to_string().contains("AdminSettleTooEarly"));
    }

    #[test]
    fn allows_admin_settle_after_delay() {
        validate_admin_settle_delay(1_000, 3_600, 4_600).unwrap();
    }

    #[test]
    fn rejects_zero_admin_settlement_price() {
        let err = validate_admin_settlement_price(0).unwrap_err();
        assert!(err.to_string().contains("InvalidSettlementPrice"));
    }
}
