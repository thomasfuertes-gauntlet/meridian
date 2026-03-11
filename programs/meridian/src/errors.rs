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
    #[msg("Unsupported ticker for this deployment")]
    UnsupportedTicker,
    #[msg("Invalid amount: must be greater than zero")]
    InvalidAmount,
    #[msg("Invalid close time for market")]
    InvalidCloseTime,
    #[msg("Vault invariant violation: balance mismatch")]
    VaultInvariantViolation,
    #[msg("Invalid token mint: not a market mint")]
    InvalidTokenMint,
    #[msg("Invalid outcome: cannot settle as Pending")]
    InvalidOutcome,
    #[msg("Invalid market state for this instruction")]
    InvalidMarketState,
    #[msg("Market trading is frozen")]
    MarketFrozen,
    #[msg("Market is not frozen")]
    MarketNotFrozen,
    #[msg("Settlement too early: market not closed yet")]
    SettlementTooEarly,
    #[msg("Admin settle too early: must wait 1 hour after close")]
    AdminSettleTooEarly,
    #[msg("Oracle price is stale")]
    PriceStale,
    #[msg("Oracle confidence band too wide")]
    PriceConfidenceTooWide,
    #[msg("Order book is full")]
    OrderBookFull,
    #[msg("Crossing orders must use a dedicated trade-path instruction")]
    CrossingOrdersUseDedicatedPath,
    #[msg("Invalid price: must be between 1 and 999999 (exclusive of 0 and 1_000_000)")]
    InvalidPrice,
    #[msg("No matching orders found")]
    NoMatchingOrders,
    #[msg("Atomic trade could not be fully filled")]
    AtomicTradeIncomplete,
    #[msg("Order not found")]
    OrderNotFound,
    #[msg("Not the order owner")]
    NotOrderOwner,
    #[msg("Order book still has active orders")]
    OrderBookNotEmpty,
    #[msg("Order book escrow is not empty")]
    OrderBookEscrowNotEmpty,
    #[msg("Missing order book validation accounts")]
    MissingOrderBookAccounts,
    #[msg("Invalid order book validation accounts")]
    InvalidOrderBookAccount,
    #[msg("Missing counterparty account for fill")]
    MissingCounterpartyAccount,
    #[msg("Invalid counterparty token account")]
    InvalidCounterpartyAccount,
    #[msg("Invalid collateral mint for market")]
    InvalidCollateralMint,
    #[msg("Oracle price is invalid")]
    InvalidOraclePrice,
    #[msg("Oracle update is outside the settlement window")]
    InvalidSettlementWindow,
}
