use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::errors::MeridianError;
use crate::state::{GlobalConfig, MarketOutcome, MarketStatus, OrderBook, StrikeMarket};

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
    require!(!market.is_settled(), MeridianError::MarketAlreadySettled);
    require!(
        market.status == MarketStatus::Frozen,
        MeridianError::MarketNotFrozen
    );

    let clock = Clock::get()?;
    // Admin settle is the fallback path and requires a configured delay.
    require!(
        clock.unix_timestamp >= market.close_time + ctx.accounts.config.admin_settle_delay_secs,
        MeridianError::AdminSettleTooEarly
    );
    validate_order_book_drained(market, &market_key, ctx.remaining_accounts)?;

    let outcome = if price >= market.strike_price {
        MarketOutcome::YesWins
    } else {
        MarketOutcome::NoWins
    };

    let market = &mut ctx.accounts.market;
    market.status = MarketStatus::Settled;
    market.outcome = outcome;
    market.settled_at = Some(clock.unix_timestamp);

    Ok(())
}

fn validate_order_book_drained<'info>(
    market: &StrikeMarket,
    market_key: &Pubkey,
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<()> {
    if !market.has_order_book() {
        return Ok(());
    }

    require!(
        remaining_accounts.len() >= 3,
        MeridianError::MissingOrderBookAccounts
    );

    let order_book_ai = &remaining_accounts[0];
    let ob_usdc_vault_ai = &remaining_accounts[1];
    let ob_yes_vault_ai = &remaining_accounts[2];

    require_keys_eq!(
        *order_book_ai.key,
        market.order_book,
        MeridianError::InvalidOrderBookAccount
    );
    require_keys_eq!(
        *ob_usdc_vault_ai.key,
        market.ob_usdc_vault,
        MeridianError::InvalidOrderBookAccount
    );
    require_keys_eq!(
        *ob_yes_vault_ai.key,
        market.ob_yes_vault,
        MeridianError::InvalidOrderBookAccount
    );

    let order_book = AccountLoader::<OrderBook>::try_from(order_book_ai)
        .map_err(|_| error!(MeridianError::InvalidOrderBookAccount))?;
    let ob = order_book
        .load()
        .map_err(|_| error!(MeridianError::InvalidOrderBookAccount))?;
    require_keys_eq!(
        ob.market,
        *market_key,
        MeridianError::InvalidOrderBookAccount
    );
    require!(!ob.has_active_orders(), MeridianError::OrderBookNotEmpty);

    let ob_usdc_vault = Account::<TokenAccount>::try_from(ob_usdc_vault_ai)
        .map_err(|_| error!(MeridianError::InvalidOrderBookAccount))?;
    let ob_yes_vault = Account::<TokenAccount>::try_from(ob_yes_vault_ai)
        .map_err(|_| error!(MeridianError::InvalidOrderBookAccount))?;

    require!(
        ob_usdc_vault.amount == 0,
        MeridianError::OrderBookEscrowNotEmpty
    );
    require!(
        ob_yes_vault.amount == 0,
        MeridianError::OrderBookEscrowNotEmpty
    );

    Ok(())
}
