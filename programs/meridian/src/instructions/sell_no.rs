use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::state::{GlobalConfig, OrderBook, StrikeMarket, USDC_PER_PAIR};

struct Fill {
    book_index: usize,
    fill_qty: u64,
    fill_cost: u64,
    remaining_acct_idx: usize,
    counterparty_owner: Pubkey,
}

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
    require!(
        !ctx.accounts.market.is_settled(),
        MeridianError::MarketAlreadySettled
    );
    require!(
        ctx.accounts.market.is_trading_active(),
        MeridianError::MarketFrozen
    );
    require!(
        max_price > 0 && max_price < USDC_PER_PAIR,
        MeridianError::InvalidPrice
    );

    let market_key = ctx.accounts.market.key();

    // 1. Escrow the maximum USDC needed to buy the matching Yes.
    let escrow_amount = amount
        .checked_mul(max_price)
        .ok_or(MeridianError::InvalidAmount)?;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.ob_usdc_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        escrow_amount,
    )?;

    // 2. Match against asks. This must fully fill.
    let (fills, total_fill_cost, ob_bump) = {
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

        let mut fills: Vec<Fill> = Vec::new();
        let mut rem_qty = amount;
        let mut total_cost: u64 = 0;
        let mut ra_idx = 0usize;
        let ask_count = ob.ask_count as usize;

        for i in 0..ask_count {
            if rem_qty == 0 {
                break;
            }
            if ob.asks[i].is_active == 0 {
                continue;
            }
            let ask_price = ob.asks[i].price;
            if ask_price > max_price {
                break;
            }

            let fill_qty = rem_qty.min(ob.asks[i].quantity);
            let fill_cost = fill_qty
                .checked_mul(ask_price)
                .ok_or(MeridianError::InvalidAmount)?;
            total_cost = total_cost
                .checked_add(fill_cost)
                .ok_or(MeridianError::InvalidAmount)?;

            fills.push(Fill {
                book_index: i,
                fill_qty,
                fill_cost,
                remaining_acct_idx: ra_idx,
                counterparty_owner: ob.asks[i].owner,
            });
            ra_idx += 1;
            rem_qty = rem_qty
                .checked_sub(fill_qty)
                .ok_or(MeridianError::InvalidAmount)?;
        }

        require!(rem_qty == 0, MeridianError::AtomicTradeIncomplete);
        require!(!fills.is_empty(), MeridianError::NoMatchingOrders);

        (fills, total_cost, ob.bump)
    };

    // 3. Execute trade transfers.
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
            ctx.accounts.ob_usdc_vault.mint,
            MeridianError::InvalidCounterpartyAccount
        );

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
            fill.fill_qty,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.ob_usdc_vault.to_account_info(),
                    to: counterparty_ata.to_account_info(),
                    authority: order_book_ai.clone(),
                },
                ob_signer,
            ),
            fill.fill_cost,
        )?;
    }

    // Refund any price improvement before burning the pair.
    let refund = escrow_amount
        .checked_sub(total_fill_cost)
        .ok_or(MeridianError::InvalidAmount)?;
    if refund > 0 {
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
            refund,
        )?;
    }

    // 4. Update the ask book.
    {
        let mut ob = ctx.accounts.order_book.load_mut()?;
        let ask_count = ob.ask_count;
        for fill in &fills {
            ob.asks[fill.book_index].quantity = ob.asks[fill.book_index]
                .quantity
                .checked_sub(fill.fill_qty)
                .ok_or(MeridianError::InvalidAmount)?;
            if ob.asks[fill.book_index].quantity == 0 {
                ob.asks[fill.book_index].is_active = 0;
            }
        }
        compact_orders(&mut ob.asks, ask_count);
        ob.ask_count = count_active(&ob.asks) as u16;
    }

    // 5. Burn the acquired Yes together with the user's No, then release USDC.
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.yes_mint.to_account_info(),
                from: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.no_mint.to_account_info(),
                from: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    let market = &ctx.accounts.market;
    let market_seeds = &[
        StrikeMarket::SEED,
        market.ticker.as_bytes(),
        &market.strike_price.to_le_bytes(),
        &market.date.to_le_bytes(),
        &[market.bump],
    ];
    let market_signer = &[&market_seeds[..]];

    let redeem_amount = amount.checked_mul(USDC_PER_PAIR).unwrap();
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            market_signer,
        ),
        redeem_amount,
    )?;

    let market = &mut ctx.accounts.market;
    market.total_pairs_minted = market.total_pairs_minted.checked_sub(amount).unwrap();

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
