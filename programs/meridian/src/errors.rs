use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    #[msg("Unauthorized: not admin")]
    Unauthorized,
    #[msg("Market already settled")]
    MarketAlreadySettled,
    #[msg("Market not settled")]
    MarketNotSettled,
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Invalid ticker")]
    InvalidTicker,
}
