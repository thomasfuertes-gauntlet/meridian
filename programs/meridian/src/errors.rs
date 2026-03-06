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
    #[msg("Invalid amount: must be greater than zero")]
    InvalidAmount,
    #[msg("Vault invariant violation: balance mismatch")]
    VaultInvariantViolation,
    #[msg("Invalid token mint: not a market mint")]
    InvalidTokenMint,
    #[msg("Invalid outcome: cannot settle as Pending")]
    InvalidOutcome,
    #[msg("Settlement too early: market not closed yet")]
    SettlementTooEarly,
    #[msg("Admin settle too early: must wait 1 hour after close")]
    AdminSettleTooEarly,
    #[msg("Oracle price is stale")]
    PriceStale,
    #[msg("Oracle confidence band too wide")]
    PriceConfidenceTooWide,
}
