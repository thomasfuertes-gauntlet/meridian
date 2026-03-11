use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub struct OraclePolicy {
    #[max_len(10)]
    pub ticker: String,
    pub feed_id: [u8; 32],
    pub confidence_filter_bps: u16,
    pub max_price_staleness_secs: i64,
}

#[account]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub paused: bool,
    pub admin_settle_delay_secs: i64,
    // Supported tickers and oracle rules live on-chain so market creation and
    // settlement share the same policy surface.
    pub oracle_policies: Vec<OraclePolicy>,
    pub bump: u8,
}

impl GlobalConfig {
    pub const DEFAULT_CONFIDENCE_FILTER_BPS: u16 = 100;
    pub const DEFAULT_MAX_PRICE_STALENESS_SECS: i64 = 300;
    pub const DEFAULT_ADMIN_SETTLE_DELAY_SECS: i64 = 3600;
    pub const MAX_ORACLE_POLICIES: usize = 7;

    // Slightly oversized to leave room for future config growth.
    pub const SPACE: usize =
        8 + 32 + 1 + 8 + 4 + (OraclePolicy::INIT_SPACE * Self::MAX_ORACLE_POLICIES) + 32 + 1;
    pub const SEED: &'static [u8] = b"config";

    pub fn oracle_policy_for_ticker(&self, ticker: &str) -> Result<&OraclePolicy> {
        self.oracle_policies
            .iter()
            .find(|policy| policy.ticker == ticker)
            .ok_or_else(|| error!(crate::errors::MeridianError::UnsupportedTicker))
    }

    pub fn default_oracle_policies() -> Vec<OraclePolicy> {
        vec![
            Self::default_policy(
                "AAPL",
                "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
            ),
            Self::default_policy(
                "MSFT",
                "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
            ),
            Self::default_policy(
                "GOOGL",
                "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
            ),
            Self::default_policy(
                "AMZN",
                "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
            ),
            Self::default_policy(
                "NVDA",
                "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
            ),
            Self::default_policy(
                "META",
                "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
            ),
            Self::default_policy(
                "TSLA",
                "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
            ),
        ]
    }

    fn default_policy(ticker: &str, feed_id_hex: &str) -> OraclePolicy {
        OraclePolicy {
            ticker: ticker.to_string(),
            feed_id: decode_feed_id(feed_id_hex),
            confidence_filter_bps: Self::DEFAULT_CONFIDENCE_FILTER_BPS,
            max_price_staleness_secs: Self::DEFAULT_MAX_PRICE_STALENESS_SECS,
        }
    }
}

fn decode_feed_id(feed_id_hex: &str) -> [u8; 32] {
    let clean = feed_id_hex.strip_prefix("0x").unwrap_or(feed_id_hex);
    let mut bytes = [0u8; 32];
    for (index, chunk) in clean.as_bytes().chunks(2).enumerate() {
        let pair = core::str::from_utf8(chunk).expect("feed id must be valid ASCII hex");
        bytes[index] = u8::from_str_radix(pair, 16).expect("feed id must be valid hex");
    }
    bytes
}
