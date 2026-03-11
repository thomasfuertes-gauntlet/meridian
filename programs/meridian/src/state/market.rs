use crate::errors::MeridianError;
use anchor_lang::prelude::*;

#[derive(Debug, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
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

#[derive(Debug, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
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

#[derive(Debug, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SettlementSource {
    Oracle,
    Admin,
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
    pub settlement_price: Option<u64>,
    pub settlement_source: Option<SettlementSource>,
    pub close_time: i64,
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

    pub fn increase_open_interest(&mut self, amount: u64) -> Result<()> {
        self.total_pairs_minted = self
            .total_pairs_minted
            .checked_add(amount)
            .ok_or_else(|| error!(MeridianError::InvalidAmount))?;
        Ok(())
    }

    pub fn consume_open_interest(&mut self, amount: u64) -> Result<()> {
        self.total_pairs_minted = self
            .total_pairs_minted
            .checked_sub(amount)
            .ok_or_else(|| error!(MeridianError::InvalidAmount))?;
        Ok(())
    }

    pub fn assert_trading_active(&self) -> Result<()> {
        require!(!self.is_settled(), MeridianError::MarketAlreadySettled);
        require!(self.is_trading_active(), MeridianError::MarketFrozen);
        Ok(())
    }

    pub fn assert_can_freeze(&self, now: i64) -> Result<()> {
        require!(!self.is_settled(), MeridianError::MarketAlreadySettled);
        require!(
            self.status == MarketStatus::Created,
            MeridianError::InvalidMarketState
        );
        require!(now >= self.close_time, MeridianError::SettlementTooEarly);
        Ok(())
    }

    pub fn assert_can_settle(&self, now: i64) -> Result<()> {
        require!(!self.is_settled(), MeridianError::MarketAlreadySettled);
        require!(
            self.status == MarketStatus::Frozen,
            MeridianError::MarketNotFrozen
        );
        require!(now >= self.close_time, MeridianError::SettlementTooEarly);
        Ok(())
    }

    pub fn apply_oracle_settlement(
        &mut self,
        outcome: MarketOutcome,
        settlement_price: u64,
        settled_at: i64,
    ) -> Result<()> {
        self.apply_settlement(
            outcome,
            settlement_price,
            SettlementSource::Oracle,
            settled_at,
        )
    }

    pub fn apply_admin_settlement(
        &mut self,
        outcome: MarketOutcome,
        settlement_price: u64,
        settled_at: i64,
    ) -> Result<()> {
        self.apply_settlement(outcome, settlement_price, SettlementSource::Admin, settled_at)
    }

    fn apply_settlement(
        &mut self,
        outcome: MarketOutcome,
        settlement_price: u64,
        settlement_source: SettlementSource,
        settled_at: i64,
    ) -> Result<()> {
        require!(!self.is_settled(), MeridianError::MarketAlreadySettled);
        require!(
            outcome != MarketOutcome::Pending,
            MeridianError::InvalidOutcome
        );
        require!(settlement_price > 0, MeridianError::InvalidSettlementPrice);
        self.status = MarketStatus::Settled;
        self.outcome = outcome;
        self.settled_at = Some(settled_at);
        self.settlement_price = Some(settlement_price);
        self.settlement_source = Some(settlement_source);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_market(status: MarketStatus, close_time: i64) -> StrikeMarket {
        StrikeMarket {
            ticker: "META".to_string(),
            strike_price: 680_000_000,
            date: 1_700_000_000,
            status,
            outcome: if status == MarketStatus::Settled {
                MarketOutcome::YesWins
            } else {
                MarketOutcome::Pending
            },
            total_pairs_minted: 2,
            yes_mint: Pubkey::default(),
            no_mint: Pubkey::default(),
            vault: Pubkey::default(),
            usdc_mint: Pubkey::default(),
            order_book: Pubkey::default(),
            ob_usdc_vault: Pubkey::default(),
            ob_yes_vault: Pubkey::default(),
            admin: Pubkey::default(),
            bump: 255,
            frozen_at: None,
            settled_at: if status == MarketStatus::Settled {
                Some(close_time + 60)
            } else {
                None
            },
            settlement_price: if status == MarketStatus::Settled {
                Some(680_000_000)
            } else {
                None
            },
            settlement_source: if status == MarketStatus::Settled {
                Some(SettlementSource::Oracle)
            } else {
                None
            },
            close_time,
        }
    }

    #[test]
    fn created_market_allows_trading() {
        let market = sample_market(MarketStatus::Created, 1_000);
        market.assert_trading_active().unwrap();
    }

    #[test]
    fn frozen_market_blocks_trading() {
        let market = sample_market(MarketStatus::Frozen, 1_000);
        let err = market.assert_trading_active().unwrap_err();
        assert!(err.to_string().contains("MarketFrozen"));
    }

    #[test]
    fn freeze_requires_market_close() {
        let market = sample_market(MarketStatus::Created, 1_000);
        let err = market.assert_can_freeze(999).unwrap_err();
        assert!(err.to_string().contains("SettlementTooEarly"));
    }

    #[test]
    fn settle_requires_frozen_state() {
        let market = sample_market(MarketStatus::Created, 1_000);
        let err = market.assert_can_settle(1_000).unwrap_err();
        assert!(err.to_string().contains("MarketNotFrozen"));
    }

    #[test]
    fn settled_market_cannot_settle_again() {
        let market = sample_market(MarketStatus::Settled, 1_000);
        let err = market.assert_can_settle(1_000).unwrap_err();
        assert!(err.to_string().contains("MarketAlreadySettled"));
    }

    #[test]
    fn apply_settlement_writes_final_state() {
        let mut market = sample_market(MarketStatus::Frozen, 1_000);
        market
            .apply_admin_settlement(MarketOutcome::NoWins, 679_000_000, 1_234)
            .unwrap();
        assert_eq!(market.status, MarketStatus::Settled);
        assert_eq!(market.outcome, MarketOutcome::NoWins);
        assert_eq!(market.settled_at, Some(1_234));
        assert_eq!(market.settlement_price, Some(679_000_000));
        assert_eq!(market.settlement_source, Some(SettlementSource::Admin));
    }

    #[test]
    fn apply_settlement_rejects_pending_outcome() {
        let mut market = sample_market(MarketStatus::Frozen, 1_000);
        let err = market
            .apply_oracle_settlement(MarketOutcome::Pending, 680_000_000, 1_234)
            .unwrap_err();
        assert!(err.to_string().contains("InvalidOutcome"));
    }

    #[test]
    fn apply_settlement_rejects_zero_price() {
        let mut market = sample_market(MarketStatus::Frozen, 1_000);
        let err = market
            .apply_admin_settlement(MarketOutcome::NoWins, 0, 1_234)
            .unwrap_err();
        assert!(err.to_string().contains("InvalidSettlementPrice"));
    }

    #[test]
    fn settled_metadata_is_immutable() {
        let mut market = sample_market(MarketStatus::Frozen, 1_000);
        market
            .apply_oracle_settlement(MarketOutcome::YesWins, 680_000_000, 1_234)
            .unwrap();

        let err = market
            .apply_admin_settlement(MarketOutcome::NoWins, 679_000_000, 1_235)
            .unwrap_err();
        assert!(err.to_string().contains("MarketAlreadySettled"));
        assert_eq!(market.outcome, MarketOutcome::YesWins);
        assert_eq!(market.settlement_source, Some(SettlementSource::Oracle));
        assert_eq!(market.settlement_price, Some(680_000_000));
    }

    #[test]
    fn open_interest_consumption_rejects_underflow() {
        let mut market = sample_market(MarketStatus::Created, 1_000);
        let err = market.consume_open_interest(3).unwrap_err();
        assert!(err.to_string().contains("InvalidAmount"));
        assert_eq!(market.total_pairs_minted, 2);
    }
}
