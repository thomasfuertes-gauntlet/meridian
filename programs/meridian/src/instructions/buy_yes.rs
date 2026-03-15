use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

use crate::errors::MeridianError;
use crate::instructions::shared::{
    apply_fills_to_orders, compute_refund, escrow_usdc, plan_ask_fills,
    refund_ob_usdc_to_user, total_fill_cost, validate_order_book_for_market,
};
use crate::state::{GlobalConfig, OrderBook, StrikeMarket, USDC_PER_PAIR};

#[cfg(test)]
use crate::state::{Order, MAX_ORDERS_PER_SIDE};

#[derive(Accounts)]
pub struct BuyYes<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [GlobalConfig::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [
            StrikeMarket::SEED,
            market.ticker.as_bytes(),
            &market.strike_price.to_le_bytes(),
            &market.date.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, StrikeMarket>>,

    #[account(
        mut,
        token::mint = market.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Account<'info, TokenAccount>,

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
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BuyYes>, amount: u64, max_price: u64) -> Result<()> {
    require!(amount > 0, MeridianError::InvalidAmount);
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    ctx.accounts.market.assert_trading_active()?;
    require!(
        max_price > 0 && max_price < USDC_PER_PAIR,
        MeridianError::InvalidPrice
    );

    let market_key = ctx.accounts.market.key();
    let order_book_ai = ctx.accounts.order_book.to_account_info();

    // Phase 1: Escrow max possible USDC from user
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

    // Phase 2: Read book, plan fills
    let (fills, total_cost, ob_bump) = {
        let ob = ctx.accounts.order_book.load()?;

        validate_order_book_for_market(
            &ob,
            &market_key,
            ctx.accounts.ob_usdc_vault.key(),
            ctx.accounts.ob_yes_vault.key(),
        )?;

        let fills = plan_ask_fills(&ob.asks, ob.ask_count as usize, amount, max_price)?;
        let cost = total_fill_cost(&fills)?;

        (fills, cost, ob.bump)
    };

    // Phase 3: CPI transfers (taker only - no counterparty accounts needed)
    let ob_seeds: &[&[u8]] = &[OrderBook::SEED, market_key.as_ref(), &[ob_bump]];
    let ob_signer = &[ob_seeds];

    // Transfer Yes tokens from vault to taker
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.ob_yes_vault.to_account_info(),
                to: ctx.accounts.user_yes.to_account_info(),
                authority: order_book_ai.clone(),
            },
            ob_signer,
        ),
        amount,
    )?;

    // Refund excess USDC to taker
    let refund = compute_refund(escrow_amount, total_cost)?;
    refund_ob_usdc_to_user(
        ctx.accounts.token_program.to_account_info(),
        order_book_ai,
        ctx.accounts.user_usdc.to_account_info(),
        ctx.accounts.ob_usdc_vault.to_account_info(),
        ob_signer,
        refund,
    )?;

    // Phase 4: Write credits to makers + apply fills
    {
        let mut ob = ctx.accounts.order_book.load_mut()?;
        for fill in &fills {
            ob.add_usdc_credit(fill.counterparty_owner, fill.fill_cost)?;
        }
        let ask_count = ob.ask_count;
        ob.ask_count = apply_fills_to_orders(&mut ob.asks, ask_count, &fills)?;
    }

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
    fn buy_yes_matches_multiple_asks_for_full_fill() {
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(300_000, 1, true);
        asks[1] = order(350_000, 2, true);

        let fills = plan_ask_fills(&asks, 2, 3, 400_000).unwrap();
        let total_cost = total_fill_cost(&fills).unwrap();
        assert_eq!(fills.len(), 2);
        assert_eq!(total_cost, 1_000_000);
    }

    #[test]
    fn buy_yes_rejects_partial_fill() {
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(300_000, 1, true);

        let err = plan_ask_fills(&asks, 1, 2, 400_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }

    #[test]
    fn buy_yes_rejects_asks_above_max_price() {
        let mut asks = [Order::default(); MAX_ORDERS_PER_SIDE];
        asks[0] = order(700_000, 1, true);

        let err = plan_ask_fills(&asks, 1, 1, 600_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }
}
