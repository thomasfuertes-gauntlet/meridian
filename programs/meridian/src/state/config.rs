use anchor_lang::prelude::*;

// Space: 8 (discriminator) + 32 (admin) + 1 (paused) + 1 (bump) = 42
#[account]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl GlobalConfig {
    pub const SPACE: usize = 8 + 32 + 1 + 1;
    pub const SEED: &'static [u8] = b"config";
}
