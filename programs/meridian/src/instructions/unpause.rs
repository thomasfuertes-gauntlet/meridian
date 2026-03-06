use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ MeridianError::Unauthorized,
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,
}

pub fn handler(ctx: Context<Unpause>) -> Result<()> {
    ctx.accounts.config.paused = false;
    Ok(())
}
