use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{Price, PriceUpdateV2, VerificationLevel};

use crate::errors::MeridianError;
use crate::instructions::shared::validate_order_book_drained;
use crate::state::{GlobalConfig, StrikeMarket};

#[cfg(test)]
use crate::instructions::shared::validate_order_book_snapshot;

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,

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

    pub price_update: Account<'info, PriceUpdateV2>,
}

pub fn handler<'info>(ctx: Context<'_, '_, 'info, 'info, SettleMarket<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let market_key = ctx.accounts.market.key();

    {
        let market = &mut ctx.accounts.market;
        market.prepare_for_settlement(clock.unix_timestamp)?;
    }

    let market = &ctx.accounts.market;
    let oracle_policy = ctx.accounts.config.oracle_policy_for_ticker(&market.ticker)?;
    validate_order_book_drained(market, &market_key, ctx.remaining_accounts)?;

    // Read a fully verified price update for this feed, then enforce that it was
    // published in the market's intended settlement window.
    let price = ctx
        .accounts
        .price_update
        .get_price_unchecked(&oracle_policy.feed_id)
        .map_err(|_| MeridianError::PriceStale)?;
    validate_price_for_settlement(
        &price,
        ctx.accounts.price_update.verification_level,
        market.close_time,
        clock.unix_timestamp,
        oracle_policy.max_price_staleness_secs,
    )?;

    // Confidence check: conf must be <= configured basis points of price.
    let price_abs = price.price.unsigned_abs();
    let conf_limit = price_abs
        .checked_mul(u64::from(oracle_policy.confidence_filter_bps))
        .ok_or(MeridianError::InvalidOraclePrice)?
        / 10_000;
    require!(
        conf_limit > 0 && price.conf <= conf_limit,
        MeridianError::PriceConfidenceTooWide
    );

    // Convert Pyth price to USDC base units (6 decimals).
    // Pyth price = price.price * 10^price.exponent
    // We want the price in units of 10^-6 (USDC micro-units).
    let oracle_price_usdc = oracle_price_to_usdc_micro(&price)?;

    // Settlement uses the product's at-or-above rule: a price exactly equal to
    // the strike resolves to YesWins.
    let outcome = market.outcome_for_price(oracle_price_usdc);

    let market = &mut ctx.accounts.market;
    market.apply_oracle_settlement(outcome, oracle_price_usdc, clock.unix_timestamp)?;

    Ok(())
}

fn validate_price_for_settlement(
    price: &Price,
    verification_level: VerificationLevel,
    close_time: i64,
    now: i64,
    max_price_staleness_secs: i64,
) -> Result<()> {
    require!(
        verification_level == VerificationLevel::Full,
        MeridianError::PriceStale
    );
    require!(price.price > 0, MeridianError::InvalidOraclePrice);
    require!(
        price.publish_time >= close_time
            && price.publish_time <= close_time + max_price_staleness_secs
            && price.publish_time <= now,
        MeridianError::InvalidSettlementWindow
    );
    Ok(())
}

fn oracle_price_to_usdc_micro(price: &Price) -> Result<u64> {
    let target_exp: i32 = -6;
    let exp_diff = price.exponent - target_exp;
    let base_price = u64::try_from(price.price).map_err(|_| MeridianError::InvalidOraclePrice)?;

    Ok(if exp_diff >= 0 {
        base_price
            .checked_mul(10u64.pow(exp_diff as u32))
            .ok_or(MeridianError::InvalidOraclePrice)?
    } else {
        base_price / 10u64.pow((-exp_diff) as u32)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_price(price: i64, exponent: i32, publish_time: i64) -> Price {
        Price {
            price,
            conf: 1,
            exponent,
            publish_time,
        }
    }

    #[test]
    fn rejects_non_full_verification() {
        let err = validate_price_for_settlement(
            &sample_price(123_450_000, -6, 1_000),
            VerificationLevel::Partial { num_signatures: 5 },
            900,
            1_000,
            300,
        )
        .unwrap_err();

        assert!(err.to_string().contains("PriceStale"));
    }

    #[test]
    fn rejects_non_positive_prices() {
        let err = validate_price_for_settlement(
            &sample_price(0, -6, 1_000),
            VerificationLevel::Full,
            900,
            1_000,
            300,
        )
        .unwrap_err();

        assert!(err.to_string().contains("InvalidOraclePrice"));
    }

    #[test]
    fn rejects_prices_outside_settlement_window() {
        let err = validate_price_for_settlement(
            &sample_price(123_450_000, -6, 1_206),
            VerificationLevel::Full,
            900,
            1_206,
            300,
        )
        .unwrap_err();

        assert!(err.to_string().contains("InvalidSettlementWindow"));
    }

    #[test]
    fn rejects_prices_from_the_future() {
        let err = validate_price_for_settlement(
            &sample_price(123_450_000, -6, 1_000),
            VerificationLevel::Full,
            900,
            999,
            300,
        )
        .unwrap_err();

        assert!(err.to_string().contains("InvalidSettlementWindow"));
    }

    #[test]
    fn converts_pyth_price_to_usdc_micro_units() {
        let converted = oracle_price_to_usdc_micro(&sample_price(680_25, -2, 1_000)).unwrap();
        assert_eq!(converted, 680_250_000);
    }

    #[test]
    fn rejects_negative_conversion_inputs() {
        let err = oracle_price_to_usdc_micro(&sample_price(-1, -6, 1_000)).unwrap_err();
        assert!(err.to_string().contains("InvalidOraclePrice"));
    }

    #[test]
    fn allows_settlement_when_no_order_book_exists() {
        validate_order_book_snapshot(false, false, 10, 10).unwrap();
    }

    #[test]
    fn rejects_settlement_with_active_orders() {
        let err = validate_order_book_snapshot(true, true, 0, 0).unwrap_err();
        assert!(err.to_string().contains("OrderBookNotEmpty"));
    }

    #[test]
    fn rejects_settlement_with_residual_escrow() {
        let err = validate_order_book_snapshot(true, false, 1, 0).unwrap_err();
        assert!(err.to_string().contains("OrderBookEscrowNotEmpty"));
    }
}
