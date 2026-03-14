use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,
}

pub fn handler(ctx: Context<UpdateConfig>, admin_settle_delay_secs: i64) -> Result<()> {
    require!(admin_settle_delay_secs >= 0, MeridianError::InvalidAmount);
    ctx.accounts.config.admin_settle_delay_secs = admin_settle_delay_secs;
    Ok(())
}
