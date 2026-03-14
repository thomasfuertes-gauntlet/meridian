#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::OrderSide;

declare_id!("GMwKXYNKRkN3wGdgAwR4BzG2RfPGGLGjehuoNwUzBGk2");

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
    ) -> Result<()> {
        instructions::create_strike_market::handler(ctx, ticker, strike_price, date, close_time)
    }

    pub fn add_strike(
        ctx: Context<AddStrike>,
        ticker: String,
        strike_price: u64,
        date: i64,
        close_time: i64,
    ) -> Result<()> {
        instructions::add_strike::handler(ctx, ticker, strike_price, date, close_time)
    }

    pub fn mint_pair(ctx: Context<MintPair>, amount: u64) -> Result<()> {
        instructions::mint_pair::handler(ctx, amount)
    }

    pub fn buy_yes(ctx: Context<BuyYes>, amount: u64, max_price: u64) -> Result<()> {
        instructions::buy_yes::handler(ctx, amount, max_price)
    }

    pub fn freeze_market(ctx: Context<FreezeMarket>) -> Result<()> {
        instructions::freeze_market::handler(ctx)
    }

    pub fn redeem<'info>(
        ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::redeem::handler(ctx, amount)
    }

    pub fn sell_yes(ctx: Context<SellYes>, amount: u64, min_price: u64) -> Result<()> {
        instructions::sell_yes::handler(ctx, amount, min_price)
    }

    pub fn claim_fills(ctx: Context<ClaimFills>) -> Result<()> {
        instructions::claim_fills::handler(ctx)
    }

    pub fn settle_market<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleMarket<'info>>,
    ) -> Result<()> {
        instructions::settle_market::handler(ctx)
    }

    pub fn admin_settle<'info>(
        ctx: Context<'_, '_, 'info, 'info, AdminSettle<'info>>,
        price: u64,
    ) -> Result<()> {
        instructions::admin_settle::handler(ctx, price)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handler(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::unpause::handler(ctx)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, admin_settle_delay_secs: i64) -> Result<()> {
        instructions::update_config::handler(ctx, admin_settle_delay_secs)
    }

    pub fn place_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
        side: OrderSide,
        price: u64,
        quantity: u64,
    ) -> Result<()> {
        instructions::place_order::handler(ctx, side, price, quantity)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
        instructions::cancel_order::handler(ctx, order_id)
    }

    pub fn unwind_order(ctx: Context<UnwindOrder>, order_id: u64) -> Result<()> {
        instructions::unwind_order::handler(ctx, order_id)
    }

    pub fn close_market(ctx: Context<CloseMarket>, force: bool) -> Result<()> {
        instructions::close_market::handler(ctx, force)
    }
}
