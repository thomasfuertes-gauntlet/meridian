use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::errors::MeridianError;
use crate::state::{
    GlobalConfig, Order, OrderBook, StrikeMarket, MAX_ORDERS_PER_SIDE, USDC_PER_PAIR,
};

#[derive(Debug)]
struct Fill {
    book_index: usize,
    fill_qty: u64,
    fill_cost: u64,
    remaining_acct_idx: usize,
    counterparty_owner: Pubkey,
}

fn compute_bid_fills(
    bids: &[Order; MAX_ORDERS_PER_SIDE],
    bid_count: usize,
    amount: u64,
    min_price: u64,
) -> Result<Vec<Fill>> {
    let mut fills: Vec<Fill> = Vec::new();
    let mut rem_qty = amount;
    let mut ra_idx = 0usize;

    for (i, bid) in bids.iter().enumerate().take(bid_count) {
        if rem_qty == 0 {
            break;
        }
        if bid.is_active == 0 {
            continue;
        }
        if bid.price < min_price {
            break;
        }

        let fill_qty = rem_qty.min(bid.quantity);
        let fill_cost = fill_qty
            .checked_mul(bid.price)
            .ok_or(MeridianError::InvalidAmount)?;

        fills.push(Fill {
            book_index: i,
            fill_qty,
            fill_cost,
            remaining_acct_idx: ra_idx,
            counterparty_owner: bid.owner,
        });
        ra_idx += 1;
        rem_qty = rem_qty
            .checked_sub(fill_qty)
            .ok_or(MeridianError::InvalidAmount)?;
    }

    require!(rem_qty == 0, MeridianError::AtomicTradeIncomplete);
    require!(!fills.is_empty(), MeridianError::NoMatchingOrders);

    Ok(fills)
}

#[derive(Accounts)]
pub struct BuyNo<'info> {
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
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = no_mint,
        associated_token::authority = user,
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
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, BuyNo<'info>>,
    amount: u64,
    min_price: u64,
) -> Result<()> {
    require!(amount > 0, MeridianError::InvalidAmount);
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(
        !ctx.accounts.market.is_settled(),
        MeridianError::MarketAlreadySettled
    );
    require!(
        ctx.accounts.market.is_trading_active(),
        MeridianError::MarketFrozen
    );
    require!(
        min_price > 0 && min_price < USDC_PER_PAIR,
        MeridianError::InvalidPrice
    );

    let market_key = ctx.accounts.market.key();
    let market = &ctx.accounts.market;
    let market_seeds = &[
        StrikeMarket::SEED,
        market.ticker.as_bytes(),
        &market.strike_price.to_le_bytes(),
        &market.date.to_le_bytes(),
        &[market.bump],
    ];
    let market_signer = &[&market_seeds[..]];

    // 1. Mint the pair against fresh USDC collateral.
    let usdc_amount = amount.checked_mul(USDC_PER_PAIR).unwrap();
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            market_signer,
        ),
        amount,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            market_signer,
        ),
        amount,
    )?;

    // 2. Escrow the freshly minted Yes into the order book.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_yes.to_account_info(),
                to: ctx.accounts.ob_yes_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // 3. Compute matches against resting bids. This must fully fill.
    let (fills, ob_bump) = {
        let ob = ctx.accounts.order_book.load()?;

        require_keys_eq!(ob.market, market_key);
        require_keys_eq!(
            ob.ob_usdc_vault,
            ctx.accounts.ob_usdc_vault.key(),
            MeridianError::VaultInvariantViolation
        );
        require_keys_eq!(
            ob.ob_yes_vault,
            ctx.accounts.ob_yes_vault.key(),
            MeridianError::VaultInvariantViolation
        );

        let fills = compute_bid_fills(&ob.bids, ob.bid_count as usize, amount, min_price)?;

        (fills, ob.bump)
    };

    // 4. Execute transfers.
    let order_book_ai = ctx.accounts.order_book.to_account_info();
    let ob_seeds: &[&[u8]] = &[OrderBook::SEED, market_key.as_ref(), &[ob_bump]];
    let ob_signer = &[ob_seeds];

    for fill in &fills {
        require!(
            fill.remaining_acct_idx < ctx.remaining_accounts.len(),
            MeridianError::MissingCounterpartyAccount
        );
        let counterparty_ata = &ctx.remaining_accounts[fill.remaining_acct_idx];
        let counterparty_token_account = Account::<TokenAccount>::try_from(counterparty_ata)
            .map_err(|_| MeridianError::InvalidCounterpartyAccount)?;

        require_keys_eq!(
            counterparty_token_account.owner,
            fill.counterparty_owner,
            MeridianError::InvalidCounterpartyAccount
        );
        require_keys_eq!(
            counterparty_token_account.mint,
            ctx.accounts.ob_yes_vault.mint,
            MeridianError::InvalidCounterpartyAccount
        );

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.ob_usdc_vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: order_book_ai.clone(),
                },
                ob_signer,
            ),
            fill.fill_cost,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.ob_yes_vault.to_account_info(),
                    to: counterparty_ata.to_account_info(),
                    authority: order_book_ai.clone(),
                },
                ob_signer,
            ),
            fill.fill_qty,
        )?;
    }

    // 5. Update the resting bid book and market collateral accounting.
    {
        let mut ob = ctx.accounts.order_book.load_mut()?;
        let bid_count = ob.bid_count;
        for fill in &fills {
            ob.bids[fill.book_index].quantity = ob.bids[fill.book_index]
                .quantity
                .checked_sub(fill.fill_qty)
                .ok_or(MeridianError::InvalidAmount)?;
            if ob.bids[fill.book_index].quantity == 0 {
                ob.bids[fill.book_index].is_active = 0;
            }
        }
        compact_orders(&mut ob.bids, bid_count);
        ob.bid_count = count_active(&ob.bids) as u16;
    }

    let market = &mut ctx.accounts.market;
    market.total_pairs_minted = market.total_pairs_minted.checked_add(amount).unwrap();

    ctx.accounts.vault.reload()?;
    let expected_vault = market.expected_vault_amount(USDC_PER_PAIR)?;
    require!(
        ctx.accounts.vault.amount == expected_vault,
        MeridianError::VaultInvariantViolation
    );

    Ok(())
}

fn compact_orders(
    orders: &mut [crate::state::Order; crate::state::MAX_ORDERS_PER_SIDE],
    count: u16,
) {
    let mut write = 0usize;
    let n = count as usize;
    for read in 0..n {
        if orders[read].is_active != 0 {
            if write != read {
                orders[write] = orders[read];
            }
            write += 1;
        }
    }
    for item in orders.iter_mut().take(n).skip(write) {
        *item = crate::state::Order::default();
    }
}

fn count_active(orders: &[crate::state::Order; crate::state::MAX_ORDERS_PER_SIDE]) -> usize {
    orders.iter().filter(|order| order.is_active != 0).count()
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
    fn buy_no_matches_multiple_bids_for_full_fill() {
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(650_000, 2, true);
        bids[1] = order(600_000, 1, true);

        let fills = compute_bid_fills(&bids, 2, 3, 550_000).unwrap();
        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0].fill_qty, 2);
        assert_eq!(fills[1].fill_qty, 1);
    }

    #[test]
    fn buy_no_rejects_partial_fill() {
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(650_000, 1, true);

        let err = compute_bid_fills(&bids, 1, 2, 600_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }

    #[test]
    fn buy_no_rejects_bids_below_min_price() {
        let mut bids = [Order::default(); MAX_ORDERS_PER_SIDE];
        bids[0] = order(500_000, 3, true);

        let err = compute_bid_fills(&bids, 1, 1, 600_000).unwrap_err();
        assert!(err.to_string().contains("AtomicTradeIncomplete"));
    }
}
