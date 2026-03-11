use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
use crate::instructions::shared::{
    apply_fills_to_orders, assert_market_vault_invariant, burn_complete_set_for_usdc,
    buy_yes_from_asks, escrow_usdc, plan_ask_fills, refund_ob_usdc_to_user, total_fill_cost,
    validate_order_book_for_market,
};
use crate::state::{
    GlobalConfig, Order, OrderBook, StrikeMarket, MAX_ORDERS_PER_SIDE, USDC_PER_PAIR,
};

#[derive(Accounts)]
pub struct SellNo<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [
            StrikeMarket::SEED,
            market.ticker.as_bytes(),
            &market.strike_price.to_le_bytes(),
            &market.date.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, StrikeMarket>,

    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"no_mint", market.key().as_ref()],
        bump,
    )]
    pub no_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
    )]
    pub user_no: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [OrderBook::SEED, market.key().as_ref()],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    #[account(
        mut,
        seeds = [b"ob_usdc_vault", market.key().as_ref()],
        bump,
    )]
    pub ob_usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"ob_yes_vault", market.key().as_ref()],
        bump,
    )]
    pub ob_yes_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SellNo<'info>>,
    amount: u64,
    max_price: u64,
) -> Result<()> {
    require!(amount > 0, MeridianError::InvalidAmount);
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    ctx.accounts.market.assert_trading_active()?;
    require!(
        max_price > 0 && max_price < USDC_PER_PAIR,
        MeridianError::InvalidPrice
    );

    let market_key = ctx.accounts.market.key();

    // 1. Escrow the maximum USDC needed to buy the matching Yes.
    let escrow_amount = amount
        .checked_mul(max_price)
        .ok_or(MeridianError::InvalidAmount)?;
    escrow_usdc(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.user_usdc.to_account_info(),
        ctx.accounts.ob_usdc_vault.to_account_info(),
        escrow_amount,
    )?;

    // 2. Match against asks. This must fully fill.
    let (fills, total_fill_cost, ob_bump) = {
        let ob = ctx.accounts.order_book.load()?;

        validate_order_book_for_market(
            &ob,
            &market_key,
            ctx.accounts.ob_usdc_vault.key(),
            ctx.accounts.ob_yes_vault.key(),
        )?;

        let fills = plan_ask_fills(&ob.asks, ob.ask_count as usize, amount, max_price)?;
        let total_cost = total_fill_cost(&fills)?;

        (fills, total_cost, ob.bump)
    };

    // 3. Execute trade transfers.
    let order_book_ai = ctx.accounts.order_book.to_account_info();
    let ob_seeds: &[&[u8]] = &[OrderBook::SEED, market_key.as_ref(), &[ob_bump]];
    let ob_signer = &[ob_seeds];
    buy_yes_from_asks(
        ctx.accounts.token_program.to_account_info(),
        order_book_ai.clone(),
        ctx.accounts.user_yes.to_account_info(),
        &ctx.accounts.ob_usdc_vault,
        &ctx.accounts.ob_yes_vault,
        ob_signer,
        &fills,
        ctx.remaining_accounts,
    )?;

    // Refund any price improvement before burning the pair.
    let refund = escrow_amount
        .checked_sub(total_fill_cost)
        .ok_or(MeridianError::InvalidAmount)?;
    refund_ob_usdc_to_user(
        ctx.accounts.token_program.to_account_info(),
        order_book_ai.clone(),
        ctx.accounts.user_usdc.to_account_info(),
        ctx.accounts.ob_usdc_vault.to_account_info(),
        ob_signer,
        refund,
    )?;

    // 4. Update the ask book.
    {
        let mut ob = ctx.accounts.order_book.load_mut()?;
        let ask_count = ob.ask_count;
        ob.ask_count = apply_fills_to_orders(&mut ob.asks, ask_count, &fills)?;
    }

    // 5. Burn the acquired Yes together with the user's No, then release USDC.
    let market = &ctx.accounts.market;
    let market_seeds = &[
        StrikeMarket::SEED,
        market.ticker.as_bytes(),
        &market.strike_price.to_le_bytes(),
        &market.date.to_le_bytes(),
        &[market.bump],
    ];
    let market_signer = &[&market_seeds[..]];

    burn_complete_set_for_usdc(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.yes_mint.to_account_info(),
        ctx.accounts.no_mint.to_account_info(),
        ctx.accounts.user_yes.to_account_info(),
        ctx.accounts.user_no.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.user_usdc.to_account_info(),
        market_signer,
        amount,
        USDC_PER_PAIR,
    )?;

    let market = &mut ctx.accounts.market;
    market.total_pairs_minted = market.total_pairs_minted.checked_sub(amount).unwrap();

    ctx.accounts.vault.reload()?;
    assert_market_vault_invariant(market, ctx.accounts.vault.amount, USDC_PER_PAIR)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(price: u64, quantity: u64, active: bool) -> Order {
        Order {
            owner: Pubkey::new_unique(),
            price,
            quantity,
            timestamp: 0,
            order_id: 1,
            is_active: u8::from(active),
            _padding: [0; 7],
        }
    }

    #[test]
    fn sell_no_matches_multiple_asks_for_full_fill() {
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(300_000, 1, true);
        asks[1] = order(350_000, 2, true);

        let fills = plan_ask_fills(&asks, 2, 3, 400_000).unwrap();
        let total_cost = total_fill_cost(&fills).unwrap();
        assert_eq!(fills.len(), 2);
        assert_eq!(total_cost, 1_000_000);
    }

    #[test]
    fn sell_no_rejects_partial_fill() {
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(300_000, 1, true);

        let err = plan_ask_fills(&asks, 1, 2, 400_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }

    #[test]
    fn sell_no_rejects_asks_above_max_price() {
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(700_000, 1, true);

        let err = plan_ask_fills(&asks, 1, 1, 600_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }
}
