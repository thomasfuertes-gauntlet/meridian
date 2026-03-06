use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct Pause<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,
}

pub fn handler(ctx: Context<Pause>) -> Result<()> {
    ctx.accounts.config.paused = true;
    Ok(())
}
