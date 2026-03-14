use anchor_lang::prelude::*;

use crate::errors::MeridianError;

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
    pub is_active: u8,     // 1, offset 64  (u8 not bool: Pod/bytemuck requires Pod-safe types for #[zero_copy])
    pub _padding: [u8; 7], // 7, offset 65 -> total 72
}

// repr(C) layout: owner(32) + usdc_claimable(8) + yes_claimable(8) = 48
// Alignment = 8
#[zero_copy]
#[derive(Default)]
pub struct CreditEntry {
    pub owner: Pubkey,        // 32, offset 0
    pub usdc_claimable: u64,  // 8, offset 32
    pub yes_claimable: u64,   // 8, offset 40
}

pub const MAX_ORDERS_PER_SIDE: usize = 32;
pub const MAX_CREDIT_ENTRIES: usize = 64;

// repr(C) layout:
//   market(32) + ob_usdc_vault(32) + ob_yes_vault(32) + next_order_id(8)
//   + bid_count(2) + ask_count(2) + bump(1) + credit_count(1) + _padding(2)
//   + bids(72*32) + asks(72*32) + credits(48*64)
//   = 112 + 2304 + 2304 + 3072 = 7792
#[account(zero_copy)]
pub struct OrderBook {
    pub market: Pubkey,                              // 32, offset 0
    pub ob_usdc_vault: Pubkey,                       // 32, offset 32
    pub ob_yes_vault: Pubkey,                        // 32, offset 64
    pub next_order_id: u64,                          // 8,  offset 96
    pub bid_count: u16,                              // 2,  offset 104
    pub ask_count: u16,                              // 2,  offset 106
    pub bump: u8,                                    // 1,  offset 108
    pub credit_count: u8,                            // 1,  offset 109
    pub _padding: [u8; 2],                           // 2,  offset 110 -> 112
    pub bids: [Order; MAX_ORDERS_PER_SIDE],          // 2304, offset 112
    pub asks: [Order; MAX_ORDERS_PER_SIDE],          // 2304, offset 2416
    pub credits: [CreditEntry; MAX_CREDIT_ENTRIES],  // 3072, offset 4720
}

impl OrderBook {
    // 8 (discriminator) + size_of::<OrderBook>()
    pub const SPACE: usize = 8 + std::mem::size_of::<OrderBook>();
    pub const SEED: &'static [u8] = b"orderbook";

    pub fn has_active_orders(&self) -> bool {
        self.bid_count > 0 || self.ask_count > 0
    }

    /// Find existing credit entry for owner, or create a new one.
    /// Returns the index into `self.credits`.
    pub fn find_or_create_credit(&mut self, owner: Pubkey) -> Result<usize> {
        for i in 0..self.credit_count as usize {
            if self.credits[i].owner == owner {
                return Ok(i);
            }
        }
        require!(
            (self.credit_count as usize) < MAX_CREDIT_ENTRIES,
            MeridianError::CreditLedgerFull
        );
        let idx = self.credit_count as usize;
        self.credits[idx].owner = owner;
        self.credits[idx].usdc_claimable = 0;
        self.credits[idx].yes_claimable = 0;
        self.credit_count += 1;
        Ok(idx)
    }

    /// Credit USDC to a maker (from a taker buy_yes fill or bid cancellation).
    pub fn add_usdc_credit(&mut self, owner: Pubkey, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let idx = self.find_or_create_credit(owner)?;
        self.credits[idx].usdc_claimable = self.credits[idx]
            .usdc_claimable
            .checked_add(amount)
            .ok_or(MeridianError::InvalidAmount)?;
        Ok(())
    }

    /// Credit Yes tokens to a maker (from a taker sell_yes fill or ask cancellation).
    pub fn add_yes_credit(&mut self, owner: Pubkey, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let idx = self.find_or_create_credit(owner)?;
        self.credits[idx].yes_claimable = self.credits[idx]
            .yes_claimable
            .checked_add(amount)
            .ok_or(MeridianError::InvalidAmount)?;
        Ok(())
    }

    /// Withdraw all credits for owner. Returns (usdc, yes) amounts.
    /// Errors if nothing to claim.
    pub fn take_credits(&mut self, owner: &Pubkey) -> Result<(u64, u64)> {
        for i in 0..self.credit_count as usize {
            if self.credits[i].owner == *owner {
                let usdc = self.credits[i].usdc_claimable;
                let yes = self.credits[i].yes_claimable;
                require!(usdc > 0 || yes > 0, MeridianError::NothingToClaim);
                self.credits[i].usdc_claimable = 0;
                self.credits[i].yes_claimable = 0;
                return Ok((usdc, yes));
            }
        }
        Err(error!(MeridianError::NothingToClaim))
    }

    /// Credit all resting orders back to their owners during settlement.
    /// Bids get USDC (price * quantity), asks get Yes (quantity).
    /// Pure memory writes - no CPI needed.
    pub fn credit_all_resting_orders(&mut self) -> Result<()> {
        // Credit resting bids: return escrowed USDC
        for i in 0..self.bid_count as usize {
            if self.bids[i].is_active != 0 {
                let amount = self.bids[i]
                    .quantity
                    .checked_mul(self.bids[i].price)
                    .ok_or(MeridianError::InvalidAmount)?;
                self.add_usdc_credit(self.bids[i].owner, amount)?;
                self.bids[i].is_active = 0;
                self.bids[i].quantity = 0;
            }
        }
        self.bid_count = 0;

        // Credit resting asks: return escrowed Yes tokens
        for i in 0..self.ask_count as usize {
            if self.asks[i].is_active != 0 {
                let amount = self.asks[i].quantity;
                self.add_yes_credit(self.asks[i].owner, amount)?;
                self.asks[i].is_active = 0;
                self.asks[i].quantity = 0;
            }
        }
        self.ask_count = 0;

        Ok(())
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
            credit_count: 0,
            _padding: [0; 2],
            bids: [Order::default(); MAX_ORDERS_PER_SIDE],
            asks: [Order::default(); MAX_ORDERS_PER_SIDE],
            credits: [CreditEntry::default(); MAX_CREDIT_ENTRIES],
        }
    }

    fn order(owner: Pubkey, price: u64, quantity: u64, order_id: u64, active: bool) -> Order {
        Order {
            owner,
            price,
            quantity,
            timestamp: 0,
            order_id,
            is_active: u8::from(active),
            _padding: [0; 7],
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

    // --- Credit ledger tests ---

    #[test]
    fn find_or_create_credit_creates_new_entry() {
        let mut ob = empty_book();
        let owner = Pubkey::new_unique();
        let idx = ob.find_or_create_credit(owner).unwrap();
        assert_eq!(idx, 0);
        assert_eq!(ob.credit_count, 1);
        assert_eq!(ob.credits[0].owner, owner);
    }

    #[test]
    fn find_or_create_credit_returns_existing_entry() {
        let mut ob = empty_book();
        let owner = Pubkey::new_unique();
        let idx1 = ob.find_or_create_credit(owner).unwrap();
        let idx2 = ob.find_or_create_credit(owner).unwrap();
        assert_eq!(idx1, idx2);
        assert_eq!(ob.credit_count, 1);
    }

    #[test]
    fn find_or_create_credit_rejects_when_full() {
        let mut ob = empty_book();
        for i in 0..MAX_CREDIT_ENTRIES {
            ob.credits[i].owner = Pubkey::new_unique();
        }
        ob.credit_count = MAX_CREDIT_ENTRIES as u8;
        let err = ob.find_or_create_credit(Pubkey::new_unique()).unwrap_err();
        assert!(err.to_string().contains("CreditLedgerFull"));
    }

    #[test]
    fn add_usdc_credit_accumulates() {
        let mut ob = empty_book();
        let owner = Pubkey::new_unique();
        ob.add_usdc_credit(owner, 500_000).unwrap();
        ob.add_usdc_credit(owner, 300_000).unwrap();
        assert_eq!(ob.credits[0].usdc_claimable, 800_000);
        assert_eq!(ob.credits[0].yes_claimable, 0);
    }

    #[test]
    fn add_yes_credit_accumulates() {
        let mut ob = empty_book();
        let owner = Pubkey::new_unique();
        ob.add_yes_credit(owner, 5).unwrap();
        ob.add_yes_credit(owner, 3).unwrap();
        assert_eq!(ob.credits[0].yes_claimable, 8);
        assert_eq!(ob.credits[0].usdc_claimable, 0);
    }

    #[test]
    fn add_credit_skips_zero_amount() {
        let mut ob = empty_book();
        ob.add_usdc_credit(Pubkey::new_unique(), 0).unwrap();
        assert_eq!(ob.credit_count, 0);
    }

    #[test]
    fn take_credits_returns_and_zeros() {
        let mut ob = empty_book();
        let owner = Pubkey::new_unique();
        ob.add_usdc_credit(owner, 1_000_000).unwrap();
        ob.add_yes_credit(owner, 5).unwrap();

        let (usdc, yes) = ob.take_credits(&owner).unwrap();
        assert_eq!(usdc, 1_000_000);
        assert_eq!(yes, 5);
        assert_eq!(ob.credits[0].usdc_claimable, 0);
        assert_eq!(ob.credits[0].yes_claimable, 0);
    }

    #[test]
    fn take_credits_rejects_when_nothing_to_claim() {
        let mut ob = empty_book();
        let err = ob.take_credits(&Pubkey::new_unique()).unwrap_err();
        assert!(err.to_string().contains("NothingToClaim"));
    }

    #[test]
    fn take_credits_rejects_zeroed_entry() {
        let mut ob = empty_book();
        let owner = Pubkey::new_unique();
        ob.add_usdc_credit(owner, 100).unwrap();
        ob.take_credits(&owner).unwrap();
        let err = ob.take_credits(&owner).unwrap_err();
        assert!(err.to_string().contains("NothingToClaim"));
    }

    #[test]
    fn credit_all_resting_orders_credits_bids_and_asks() {
        let mut ob = empty_book();
        let bid_owner = Pubkey::new_unique();
        let ask_owner = Pubkey::new_unique();

        ob.bids[0] = order(bid_owner, 600_000, 3, 1, true);
        ob.bid_count = 1;
        ob.asks[0] = order(ask_owner, 400_000, 5, 2, true);
        ob.ask_count = 1;

        ob.credit_all_resting_orders().unwrap();

        assert_eq!(ob.bid_count, 0);
        assert_eq!(ob.ask_count, 0);
        assert_eq!(ob.credit_count, 2);

        // Bid owner gets USDC back (price * quantity)
        let (usdc, yes) = ob.take_credits(&bid_owner).unwrap();
        assert_eq!(usdc, 1_800_000); // 600_000 * 3
        assert_eq!(yes, 0);

        // Ask owner gets Yes tokens back (quantity)
        let (usdc, yes) = ob.take_credits(&ask_owner).unwrap();
        assert_eq!(usdc, 0);
        assert_eq!(yes, 5);
    }

    #[test]
    fn credit_all_resting_orders_merges_same_owner() {
        let mut ob = empty_book();
        let owner = Pubkey::new_unique();

        ob.bids[0] = order(owner, 500_000, 2, 1, true);
        ob.bids[1] = order(owner, 400_000, 1, 2, true);
        ob.bid_count = 2;

        ob.credit_all_resting_orders().unwrap();

        let (usdc, _) = ob.take_credits(&owner).unwrap();
        assert_eq!(usdc, 1_400_000); // 500_000*2 + 400_000*1
    }

    #[test]
    fn credit_all_resting_orders_skips_inactive() {
        let mut ob = empty_book();
        let active_owner = Pubkey::new_unique();
        let inactive_owner = Pubkey::new_unique();

        ob.bids[0] = order(active_owner, 500_000, 2, 1, true);
        ob.bids[1] = order(inactive_owner, 400_000, 1, 2, false);
        ob.bid_count = 2;

        ob.credit_all_resting_orders().unwrap();

        assert_eq!(ob.credit_count, 1);
        let (usdc, _) = ob.take_credits(&active_owner).unwrap();
        assert_eq!(usdc, 1_000_000);
    }
}
