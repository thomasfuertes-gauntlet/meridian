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

    // KEY-DECISION 2026-03-17: devnet (hermes-beta) feed IDs, not mainnet.
    // Mainnet and devnet Pyth use different feed IDs for the same equities.
    // Verified via: hermes-beta.pyth.network/v2/price_feeds?query=<TICKER>&asset_type=equity
    pub fn default_oracle_policies() -> Vec<OraclePolicy> {
        vec![
            Self::default_policy(
                "AAPL",
                "afcc9a5bb5eefd55e12b6f0b4c8e6bccf72b785134ee232a5d175afd082e8832",
            ),
            Self::default_policy(
                "MSFT",
                "4e10201a9ad79892f1b4e9a468908f061f330272c7987ddc6506a254f77becd7",
            ),
            Self::default_policy(
                "GOOGL",
                "545b468a0fc88307cf64f7cda62b190363089527f4b597887be5611b6cefe4f1",
            ),
            Self::default_policy(
                "AMZN",
                "095e126b86f4f416a21da0c44b997a379e8647514a1b78204ca0a6267801d00f",
            ),
            Self::default_policy(
                "NVDA",
                "16e38262485de554be6a09b0c1d4d86eb2151a7af265f867d769dee359cec32e",
            ),
            Self::default_policy(
                "META",
                "057aef33dd5ca9b91bef92c6aee08bca76565934008ed3c8d55e382ed17fb883",
            ),
            Self::default_policy(
                "TSLA",
                "7dac7cafc583cc4e1ce5c6772c444b8cd7addeecd5bedb341dfa037c770ae71e",
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
