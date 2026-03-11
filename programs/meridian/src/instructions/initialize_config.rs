use anchor_lang::prelude::*;

use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = GlobalConfig::SPACE,
        seeds = [GlobalConfig::SEED],
        bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.paused = false;
    config.default_conf_filter_bps = GlobalConfig::DEFAULT_CONF_FILTER_BPS;
    config.max_price_staleness_secs = GlobalConfig::DEFAULT_MAX_PRICE_STALENESS_SECS;
    config.admin_settle_delay_secs = GlobalConfig::DEFAULT_ADMIN_SETTLE_DELAY_SECS;
    config.bump = ctx.bumps.config;
    Ok(())
}
