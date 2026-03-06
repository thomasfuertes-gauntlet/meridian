pub mod config;
pub mod market;

pub use config::*;
pub use market::*;

/// 1.00 USDC in base units (6 decimals)
pub const USDC_PER_PAIR: u64 = 1_000_000;
