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

// Space: 8 (discriminator) + (4 + 10) (ticker String) + 8 (strike_price) + 8 (date)
//      + 1 (outcome) + 8 (total_pairs_minted) + 32 (yes_mint) + 32 (no_mint)
//      + 32 (vault) + 32 (admin) + 1 (bump) + (1 + 8) (settled_at Option<i64>)
//      + 8 (close_time) + 32 (pyth_feed_id) = 225
#[account]
pub struct StrikeMarket {
    pub ticker: String,
    pub strike_price: u64,
    pub date: i64,
    pub outcome: MarketOutcome,
    pub total_pairs_minted: u64,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub admin: Pubkey,
    pub bump: u8,
    pub settled_at: Option<i64>,
    pub close_time: i64,
    pub pyth_feed_id: [u8; 32],
}

impl StrikeMarket {
    pub const SPACE: usize = 8 + (4 + 10) + 8 + 8 + 1 + 8 + 32 + 32 + 32 + 32 + 1 + 9 + 8 + 32;
    pub const SEED: &'static [u8] = b"market";
    pub const MAX_TICKER_LEN: usize = 10;
}
