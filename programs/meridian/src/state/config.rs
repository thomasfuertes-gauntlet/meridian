use anchor_lang::prelude::*;

#[account]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub paused: bool,
    pub default_conf_filter_bps: u16,
    pub max_price_staleness_secs: i64,
    pub admin_settle_delay_secs: i64,
    pub bump: u8,
}

impl GlobalConfig {
    pub const DEFAULT_CONF_FILTER_BPS: u16 = 100;
    pub const DEFAULT_MAX_PRICE_STALENESS_SECS: i64 = 300;
    pub const DEFAULT_ADMIN_SETTLE_DELAY_SECS: i64 = 3600;

    // Slightly oversized to leave room for future config growth.
    pub const SPACE: usize = 8 + 64;
    pub const SEED: &'static [u8] = b"config";
}
