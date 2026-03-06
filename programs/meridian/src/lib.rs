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
        close_time: i64,
        pyth_feed_id: [u8; 32],
    ) -> Result<()> {
        instructions::create_strike_market::handler(ctx, ticker, strike_price, date, close_time, pyth_feed_id)
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

    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        instructions::settle_market::handler(ctx)
    }

    pub fn admin_settle(ctx: Context<AdminSettle>, price: u64) -> Result<()> {
        instructions::admin_settle::handler(ctx, price)
    }
}
