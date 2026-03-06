use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::MarketOutcome;

declare_id!("G8kuCKKgU3uTswZPzkP5iXhSWd15ejKgnpr9atJx7azD");

#[program]
pub mod meridian {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize_config::handler(ctx)
    }

    pub fn create_strike_market(
        ctx: Context<CreateStrikeMarket>,
        ticker: String,
        strike_price: u64,
        date: i64,
    ) -> Result<()> {
        instructions::create_strike_market::handler(ctx, ticker, strike_price, date)
    }

    pub fn mint_pair(ctx: Context<MintPair>) -> Result<()> {
        instructions::mint_pair::handler(ctx)
    }

    pub fn burn_pair(ctx: Context<BurnPair>, amount: u64) -> Result<()> {
        instructions::burn_pair::handler(ctx, amount)
    }

    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        instructions::redeem::handler(ctx, amount)
    }

    pub fn settle_market(ctx: Context<SettleMarket>, outcome: MarketOutcome) -> Result<()> {
        instructions::settle_market::handler(ctx, outcome)
    }
}
