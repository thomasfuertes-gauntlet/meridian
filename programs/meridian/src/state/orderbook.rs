use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum OrderSide {
    Bid,
    Ask,
}

// repr(C) layout: owner(32) + price(8) + quantity(8) + timestamp(8) + order_id(8) + is_active(1) + _pad(7) = 72
// Alignment = 8 (from u64 fields)
#[zero_copy]
#[derive(Default)]
pub struct Order {
    pub owner: Pubkey,     // 32, offset 0
    pub price: u64,        // 8, offset 32
    pub quantity: u64,     // 8, offset 40
    pub timestamp: i64,    // 8, offset 48
    pub order_id: u64,     // 8, offset 56
    pub is_active: u8,     // 1, offset 64
    pub _padding: [u8; 7], // 7, offset 65 -> total 72
}

pub const MAX_ORDERS_PER_SIDE: usize = 32;

// repr(C) layout:
//   market(32) + ob_usdc_vault(32) + ob_yes_vault(32) + next_order_id(8)
//   + bid_count(2) + ask_count(2) + bump(1) + _padding(3)
//   + bids(72*32) + asks(72*32)
//   = 32+32+32+8+2+2+1+3 + 2304 + 2304 = 4720
#[account(zero_copy)]
pub struct OrderBook {
    pub market: Pubkey,                     // 32, offset 0
    pub ob_usdc_vault: Pubkey,              // 32, offset 32
    pub ob_yes_vault: Pubkey,               // 32, offset 64
    pub next_order_id: u64,                 // 8,  offset 96
    pub bid_count: u16,                     // 2,  offset 104
    pub ask_count: u16,                     // 2,  offset 106
    pub bump: u8,                           // 1,  offset 108
    pub _padding: [u8; 3],                  // 3,  offset 109 -> 112 (8-byte aligned for bids)
    pub bids: [Order; MAX_ORDERS_PER_SIDE], // 72 * 32 = 2304, offset 112
    pub asks: [Order; MAX_ORDERS_PER_SIDE], // 72 * 32 = 2304, offset 2416
}

impl OrderBook {
    // 8 (discriminator) + size_of::<OrderBook>()
    pub const SPACE: usize = 8 + std::mem::size_of::<OrderBook>();
    pub const SEED: &'static [u8] = b"orderbook";

    pub fn has_active_orders(&self) -> bool {
        self.bid_count > 0 || self.ask_count > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_book() -> OrderBook {
        OrderBook {
            market: Pubkey::new_unique(),
            ob_usdc_vault: Pubkey::new_unique(),
            ob_yes_vault: Pubkey::new_unique(),
            next_order_id: 1,
            bid_count: 0,
            ask_count: 0,
            bump: 255,
            _padding: [0; 3],
            bids: [Order::default(); MAX_ORDERS_PER_SIDE],
            asks: [Order::default(); MAX_ORDERS_PER_SIDE],
        }
    }

    #[test]
    fn has_active_orders_is_false_when_counts_are_zero() {
        let order_book = empty_book();
        assert!(!order_book.has_active_orders());
    }

    #[test]
    fn has_active_orders_is_true_when_bid_count_is_nonzero_even_if_array_entry_is_inactive() {
        let mut order_book = empty_book();
        order_book.bid_count = 1;
        order_book.bids[0].is_active = 0;
        assert!(order_book.has_active_orders());
    }

    #[test]
    fn has_active_orders_is_true_when_ask_count_is_nonzero_even_if_array_entry_is_inactive() {
        let mut order_book = empty_book();
        order_book.ask_count = 1;
        order_book.asks[0].is_active = 0;
        assert!(order_book.has_active_orders());
    }
}
