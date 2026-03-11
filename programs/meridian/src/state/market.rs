use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MarketOutcome {
    Pending,
    YesWins,
    NoWins,
}

impl Default for MarketOutcome {
    fn default() -> Self {
        MarketOutcome::Pending
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Created,
    Frozen,
    Settled,
}

impl Default for MarketStatus {
    fn default() -> Self {
        MarketStatus::Created
    }
}

#[account]
pub struct StrikeMarket {
    pub ticker: String,
    pub strike_price: u64,
    pub date: i64,
    pub status: MarketStatus,
    pub outcome: MarketOutcome,
    pub total_pairs_minted: u64,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub usdc_mint: Pubkey,
    pub order_book: Pubkey,
    pub ob_usdc_vault: Pubkey,
    pub ob_yes_vault: Pubkey,
    pub admin: Pubkey,
    pub bump: u8,
    pub frozen_at: Option<i64>,
    pub settled_at: Option<i64>,
    pub close_time: i64,
    pub pyth_feed_id: [u8; 32],
}

impl StrikeMarket {
    // Slightly oversized to leave room for the explicit lifecycle metadata.
    pub const SPACE: usize = 8 + 320;
    pub const SEED: &'static [u8] = b"market";
    pub const MAX_TICKER_LEN: usize = 10;

    pub fn is_trading_active(&self) -> bool {
        self.status == MarketStatus::Created && self.outcome == MarketOutcome::Pending
    }

    pub fn is_settled(&self) -> bool {
        self.status == MarketStatus::Settled
    }

    pub fn has_order_book(&self) -> bool {
        self.order_book != Pubkey::default()
    }

    pub fn expected_vault_amount(&self, usdc_per_pair: u64) -> Result<u64> {
        self.total_pairs_minted
            .checked_mul(usdc_per_pair)
            .ok_or_else(|| error!(crate::errors::MeridianError::InvalidAmount))
    }
}
