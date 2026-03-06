use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub user: Signer<'info>,
}

pub fn handler(_ctx: Context<CancelOrder>, _order_id: u64) -> Result<()> {
    Ok(())
}
