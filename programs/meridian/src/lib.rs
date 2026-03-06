use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

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
}
