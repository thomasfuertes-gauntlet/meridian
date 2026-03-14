# Meridian

Binary outcome markets for MAG7 stocks on Solana. Users trade Yes/No tokens on whether a stock closes above a strike price. $1 USDC payout invariant.

> **This file**: AI assistant context - architecture decisions, dev gotchas, conventions not recoverable from code.
> For developer onboarding and setup, see `README.md`. For architecture deep-dive, see `OVERVIEW.md`.

## Architecture

- **Canonical client spec**: `spec.md`.
- **Architecture overview**: `OVERVIEW.md`. CLOB design, credit/claim model, Phoenix/OpenBook/Drift comparisons.
- Legacy instruction surface (`buy_no`, `sell_no`, `burn_pair`) is dead and removed. Do not build new work on top of it.
- Market state machine: Created -> Frozen -> Settled. Settlement auto-freezes via `prepare_for_settlement()`, then auto-credits all resting orders via `auto_credit_resting_orders()`. No manual freeze/drain cycle required.
- `freeze_market` remains available to pre-freeze before settlement window (automation uses this to block minting during 4:00-4:05 PM).
- USDC uses 6 decimal places. 1.00 USDC = 1_000_000 base units. All invariant checks at base-unit precision.
- Position constraints are frontend-only UX guardrails. Tokens are freely transferable SPL tokens.
- "Closing price" = Pyth real-time price at ~4:05 PM ET, not official NYSE/NASDAQ close.

## Stack

- Anchor 0.32.0 / Solana CLI 3.1.9 / Rust 1.94.0
- `pyth-solana-receiver-sdk` 1.1.0 (pull-based oracle, PriceUpdateV2)
- Standard SPL tokens (0 decimals for Yes/No, 6 for USDC). Custom devnet USDC mint.
- Program ID: `GMwKXYNKRkN3wGdgAwR4BzG2RfPGGLGjehuoNwUzBGk2` (deterministic: `sha256("meridian-dev-program")`)
- Built-in CLOB (32 orders/side, zero_copy OrderBook, separate escrow vaults per market)

## Decisions Resolved

- Tokens: Standard SPL (not Token-2022). Mint authority = market PDA.
- Pyth: `pyth-solana-receiver-sdk` 1.1.0 (pull-based). Works with Anchor 0.32.
- Time: UTC Unix timestamps on-chain. ET conversion in automation service.
- settle_market is permissionless (anyone can crank). admin_settle is admin-only with configurable delay (`admin_settle_delay_secs`, default 3600s, tunable via `update_config`). **Devnet automation tries settle_market first** (fetches VAA from Hermes, posts PriceUpdateV2 on-chain) then falls back to admin_settle. Cron fires at 4:07 PM ET. If oracle path fails (timing window miss or Hermes issues), admin_settle retries until 5:00 PM ET. Set `HERMES_URL=https://hermes-beta.pyth.network` for devnet-compatible Wormhole VAAs. Local dev uses `update_config` to set delay to 60s for rapid cycles.
- Oracle policy now lives in `GlobalConfig.oracle_policies` keyed by ticker. Markets no longer store per-market feed IDs.
- **Order Book: Built-in CLOB over Phoenix DEX.** Phoenix requires per-user per-market "seat approval" by market authority before trading, devnet program ID is undocumented, and CPI docs for atomic mint-and-sell are sparse. Building a minimal CLOB in the Anchor program is both more practical for the sprint and scores higher per spec ("more ambitious, but demonstrates deeper understanding").
- **Keep `buy_yes` / `sell_yes` as atomic taker instructions.** They are the only path for atomic fill-or-kill crossing of the CLOB. Credit/claim model (commit 8a06400) eliminated `remaining_accounts` entirely - fills credit maker balances in OrderBook zero_copy memory, makers withdraw via `claim_fills`. Taker txs are fully deterministic.

## Conventions

- Settlement rule: closing price >= strike = Yes wins (at-or-above)
- Automation pauses minting before settlement to prevent 4:00-4:05 PM exploit window
- Settlement auto-credits all resting orders during settle (pure memory writes, no CPI). No drain requirement. `claim_fills` works in any market state (Created/Frozen/Settled).
- Sell No limit orders are not supported. The `buy_yes` + `redeem` composition requires the fill to complete before redeem can execute. Market orders only for Sell No.

## Dev Environment

- Source toolchain: `source ~/.cargo/env`. On this host, fresh non-interactive `zsh -lc` shells already resolve both Solana and Anchor, so the extra Solana `PATH` export is currently redundant.
- Commands in this environment run through non-interactive `zsh`; keep toolchain setup in shell startup files that `zsh -lc` reads, not only in interactive-only shell config.
- Tests use `.accountsPartial({})` not `.accounts({})` - Anchor 0.32 auto-resolves PDAs.
- `vault.reload()` after CPI transfers to refresh cached account data before invariant checks.
- Pyth equity feeds only update during US market hours on devnet. Use admin_settle for off-hours testing. Use `OFFLINE=1` for synthetic bot prices outside market hours.
- `StrikeMarket` stores `usdc_mint` (added after `vault`). Changing field order shifts Borsh layout - existing accounts incompatible. Devnet: `make devnet-reset` creates fresh markets.
- **Deterministic dev wallets** in `.wallets/` (gitignored) - see README for derivation details and security warning.
- **Frontend auto-sign**: On localhost, "Dev Wallet" appears in wallet picker. Uses bot-b keypair, pre-funded locally with 250,000 USDC + 5 SOL. On devnet, `setup-devnet` funds both bots with 250,000 USDC each. Phantom also available via Wallet Standard alongside Dev Wallet.
- Prefer a local `frontend/.env.local` for frontend-only local overrides; do not use Vite env files to drive root bootstrap scripts.
- USDC mint address written to `frontend/src/lib/local-config.json` by setup script (gitignored, changes per session).
- Phantom must use custom RPC `http://localhost:8899` for local dev (not devnet setting).
- Do not make frontend startup auto-seed local state. Treat validator/deploy/setup/bot seeding as explicit orchestration steps.

## CLOB Dev Notes

- OrderBook uses `#[account(zero_copy)]` + `AccountLoader` (4720 bytes exceeds 4096 stack limit for Borsh).
- `AccountLoader` does not support `has_one` or field constraints in `#[account()]` - validate in handler body.
- Escrow vaults (`ob_usdc_vault`, `ob_yes_vault`) are separate from the market vault. CLOB never touches market vault.
- **Credit/claim model**: Taker fills (`buy_yes`/`sell_yes`) do one CPI transfer to the taker, then credit maker balances in OrderBook zero_copy memory. No `remaining_accounts` needed. Makers withdraw via `claim_fills` (permissionless, any market state). OrderBook SPACE: 7800 bytes (was 4728). Breaking layout change per deploy.
- `placeOrder` validates user's Yes ATA exists for both bid and ask sides. Create ATAs with `createAssociatedTokenAccountIdempotentInstruction` before any orders - don't rely on `mintPair` side effects.
- **Two local validator contexts**: `anchor test` starts its own ephemeral validator (faucet enabled, used by test helpers). `make local` starts a persistent validator (`--faucet-port 0`, admin funds via transfer). Don't mix them - run `make local-test-anchor` for the test suite, `make local` for interactive dev.
- `seed-bots` on a non-empty order book can fail (new asks cross existing bids, triggering fills). For a fresh local start, prefer `make local-validator-reset && make local`.

## WebSocket Architecture

- Bots use Solana WS subscriptions (single active-market sub). Frontend uses RPC polling (no WS subs in MarketDataProvider). No read-api.
- `scripts/ws-cache.ts`: shared WS cache. `createWsCache(connection, program)` subscribes to only the active market's orderbook (1 WS sub, fits Helius free-tier 5-sub limit). Writes parsed book state to `/tmp/meridian-ws-books.json`. Live-bots owns the cache; strategy-bots reads the shared file via `loadSharedBooks()`. Rotates sub every 10s based on active-market signal.
- Frontend: `frontend/src/lib/ws-market-data.tsx` provides `MarketDataProvider` context. Cold-loads via `getProgramAccounts`, then polls orderbooks + market status via `getMultipleAccountsInfo` every 10s. No per-market WS subs (Helius free tier caps at 5). Pyth prices refresh every 30s via HTTP (not Solana RPC). Activity feed uses a single `onLogs` WS sub, cleaned up on page unmount.

## Frontend Dev Notes

- **No Tailwind.** Frontend uses semantic HTML (nav, section, table, dl, form, etc.) with global CSS in `index.css`. Element selectors + CSS custom properties + `data-*` attributes for state. No utility classes.
- Zero-copy OrderBook must be parsed from raw buffer in frontend (Anchor IDL codegen doesn't support zero_copy). See `frontend/src/lib/orderbook.ts`.
- Current active trade composition is:
  Buy No = `mint_pair` + `sell_yes`
  Sell No = `buy_yes` + `redeem`
  Pre-settlement complete-set exits should route through `redeem`, not `burn_pair`.
- `vite-plugin-node-polyfills` required for Buffer/crypto in Solana libs.
- Pyth Hermes equity feed IDs verified via `hermes.pyth.network/v2/price_feeds?query=TICKER&asset_type=equity`. Don't guess IDs.
- Pyth Hermes batch endpoint is all-or-nothing: one invalid feed ID returns 404 for entire batch. Frontend fetches individually via Promise.allSettled.
- `accountsPartial` silently ignores unknown keys. Always match IDL names exactly (camelCase in TS, snake_case in IDL - SDK converts). Wrong names compile fine but fail at runtime with "Account X not provided".
- `mintPair(amount)` takes a u64 amount. `burnPair` is disabled at runtime and should not be used for new work.
- `@solana/wallet-adapter-wallets` removed. Phantom self-registers via Wallet Standard. `wallets` array is empty on production, only `LocalDevWalletAdapter` on localhost.
- `vite.config.js` is gitignored. Vite handles `.ts` config natively. Stale `.js` from tsc crashes Vite when `"type": "module"` is set in package.json.

## Bot System

- `DEMO_TICKER` scopes all bot activity to a single ticker. Defaults to `NVDA` when unset (hard default in `getBotTickerFilter()`). `LOCAL_TS_ENV` now passes it to all local bot commands.
- **Active market focus**: Bots weight 80% of activity toward the strike the user is viewing. Signal path: locally, Vite dev middleware writes `/tmp/meridian-active-market.txt`; on Railway, frontend SPA POSTs to `VITE_SIGNAL_URL` (bots service `scripts/signal-server.ts` on `PORT`), which writes the same file inside the bots container. `ACTIVE_MARKET` env var is a static fallback. File stale after 5 min.
- bot-a = market maker (live-bots). bot-b = frontend dev wallet + strategy bots. bot-c/d/e/f are strategy labels, not wallets.
- Bots use deterministic wallets from `.wallets/`. Admin wallet is USDC mint authority. No secrets in `local-config.json`.
- `OFFLINE=1` skips Pyth Hermes and uses synthetic random-walk prices seeded near strikes. Without it: auto-detects market hours - warns loudly if Hermes fails during trading hours, silently falls back outside hours.
- `package.json` has `"type": "module"`. Scripts use `import.meta.dirname` (not `__dirname`). `tsx` handles ESM natively; root tsconfig stays `commonjs` for `ts-mocha` test compat.

## Devnet / Railway Deployment

- Devnet operator config: `config/devnet.env` (copy from `config/devnet.env.example`). Treat `DEVNET_RPC_URL` and `DEVNET_USDC_MINT` there as the repo deploy source of truth - not hardcoded Makefile defaults.
- Bot scripts accept `USDC_MINT` env var (falls back to `local-config.json`). Airdrop only on localhost (devnet faucets rate-limit).
- `make nuke` tears down all devnet state: force-settles markets, closes them (recovering ~70% of rent), drains bot wallets to admin. Interactive y/N confirmation.
- Frontend `?debug` query param logs all Solana RPC calls and Pyth Hermes fetches to browser console.
- See README `## Railway Deployment` for full Railway setup, env var table, and service architecture.
