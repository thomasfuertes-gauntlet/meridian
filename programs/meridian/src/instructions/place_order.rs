use anchor_lang::prelude::*;
use crate::state::OrderSide;

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub user: Signer<'info>,
}

pub fn handler(_ctx: Context<PlaceOrder>, _side: OrderSide, _price: u64, _quantity: u64) -> Result<()> {
    Ok(())
}
