# Meridian

Binary outcome markets for MAG7 stocks on Solana. Users trade Yes/No tokens on whether a stock closes above a strike price, with a hard $1 USDC payout invariant.

> **This file**: developer onboarding - repo layout, setup, local/devnet workflow.
> Architecture deep-dive: `OVERVIEW.md`. Dev context and conventions: `CLAUDE.md`.

## Repo Layout

- `programs/meridian/` - Anchor smart contract (built-in CLOB, credit/claim settlement)
- `tests/` - validator-backed TypeScript integration tests
- `frontend/` - Vite + React SPA (no Tailwind, semantic HTML + CSS custom properties)
- `scripts/` - dev tooling, bot strategies, fair-value engine, automation cron jobs
- `mock-pyth/` - lightweight mock Pyth oracle for hermetic localnet testing

## Architecture at a Glance

- **18 on-chain instructions** - see `OVERVIEW.md` for the full contract surface.
- **Market lifecycle**: Created → Frozen → Settled. Settlement auto-credits all resting orders (no drain requirement).
- **Four trade paths** on one Yes/USDC order book: Buy Yes, Sell Yes, Buy No (`mint_pair` + `sell_yes`), Sell No (`buy_yes` + `redeem`).
- **Hermetic oracle testing** - A lightweight mock Pyth program (`mock-pyth/`) runs on localnet, enabling the full permissionless `settle_market` oracle path without network dependencies. Same validation chain (feed ID, staleness, confidence, verification level) runs against deterministic test data.
- **Devnet settlement**: Automation cron fires at **4:07 PM ET**. Tries `settle_market` (Pyth pull oracle, no delay) first; falls back to `admin_settle` (1hr delay, retries until ~5:00 PM ET). Set `HERMES_URL=https://hermes-beta.pyth.network` for devnet-compatible Wormhole VAAs. Localnet settlement uses the same oracle path via mock-pyth, with `admin_settle` as fallback.
- **Oracle**: Pyth pull-based. Staleness threshold 300s, confidence band reject > 1% of price. Both configurable per ticker in `GlobalConfig.oracle_policies`.

## Local Workflow

Use the Solana + Cargo toolchain first:

```bash
source ~/.cargo/env
```

On this host, fresh non-interactive `zsh -lc` shells already pick up both Solana and Anchor from shell startup files, so the extra Solana `PATH` export is currently redundant.

Primary local commands:

```bash
make local              # validator → deploy → 12-min markets → seeded books
make local-cycle        # rotate to fresh markets (settles old ones first)
make local-settle       # settle + close all current markets
make local-seed         # re-seed order books with bot liquidity
make test               # run Anchor/TS test suite (or: make test GREP='pattern')
make uat                # E2E lifecycle test: create → mint → trade → settle → redeem
cd frontend && npm test # run frontend unit tests (orderbook, portfolio, position, trade, format)
cd frontend && npm run dev
```

`make local` manages its own background validator. Frontend startup and chain bootstrap are intentionally separate - restart the UI without recreating markets. Use `frontend/.env.local` with `VITE_RPC_URL=http://127.0.0.1:8899` for frontend-only local overrides.

## Bootstrap (Dev Wallets)

Dev wallets are derived deterministically from `sha256("meridian-dev-{name}")` - every clone produces the same keys. Wallets: `admin`, `bot-a`, `bot-b`. Files live in `.wallets/` (gitignored), generated at runtime.

```bash
make _wallets            # write .wallets/*.json from deterministic seed (internal; called automatically by other targets)
```

Then fund admin with devnet SOL (needed before any on-chain ops):

```bash
solana airdrop 5 $(solana-keygen pubkey .wallets/admin.json) --url devnet
# or use https://faucet.solana.com if airdrop rate-limits
```

Then bootstrap the program and markets:

```bash
make devnet-deploy       # build + deploy program + ensure USDC mint + GlobalConfig
```

> **Devnet only.** Deterministic keys are in committed code - compromised if the repo goes public. Production requires HSM/multisig (see [Production Hardening Roadmap](#production-hardening-roadmap)).

## Devnet Deploy

From `git clone` to ~49 live markets on devnet:

```bash
npm ci
cp .env.example .env     # fill in DEVNET_RPC_URL, DEVNET_USDC_MINT

# First-time bootstrap (fresh program)
WALLET_MODE=generate npx tsx scripts/dev-wallets.ts  # generate keypairs
npx tsx scripts/patch-program-id.ts                  # embed program ID in Anchor.toml
npx tsx scripts/devnet-fund.ts                       # airdrop SOL to wallets
make devnet-deploy                                   # build + deploy + USDC mint + GlobalConfig
```

Then run the frontend:

```bash
cd frontend && npm run dev
```

**Prerequisites:** Rust + Solana CLI + Anchor toolchain (see [Solana install docs](https://docs.solana.com/cli/install-solana-cli-tools)).

> Set `DEVNET_RPC_URL` in `.env` (copy from `.env.example`). [Helius](https://helius.dev) Developer plan ($49/mo) recommended - 50 req/s, 10M credits/mo. Free tier (10 req/s, 1M credits) works but bots burn through credits fast.

### Existing deployment (shared config)

If you're working with an already-deployed program and USDC mint:

```bash
cp .env.example .env
# Fill in DEVNET_RPC_URL, DEVNET_USDC_MINT
make devnet-deploy   # build + deploy + ensure USDC mint + GlobalConfig
make devnet-health   # verify deployment
```

## RPC Provider Requirements

### WebSocket subscription count

| Consumer | WS subs | Notes |
|---|---|---|
| Bots (`live-bots`) | 1 | `onAccountChange` round-robin through all NVDA orderbooks; rotates every 10s |
| Frontend (activity feed) | 1 | `onLogs` for the program; cleaned up on page unmount |
| Frontend (market data) | 0 | Pure RPC polling via `getMultipleAccountsInfo` every 10s |
| **Total** | **2** | Well within Helius WS limits |

### Provider compatibility

- **Helius** (recommended): reliable WS, 50 req/s on Developer plan (10 req/s free tier). Use for devnet and production.
- **Public devnet RPC** (`api.devnet.solana.com`): silently drops WS connections and aggressively rate-limits HTTP. Not suitable for bot operation.
- **Alchemy / QuickNode**: not tested; both support WS. Minimum 2 concurrent WS subs required.

### Fallback behavior when WS is unavailable

- **Bots**: `ws-cache.ts` detects WS silence after 2 minutes and re-subscribes. Initial book state is fetched via `getAccountInfo` RPC, so bots have a snapshot even before WS fires. Strategy-bots read from a shared tmpfile written by live-bots - if live-bots WS is dead, strategy-bots see stale book data until WS recovers.
- **Frontend market data**: Unaffected - market data uses polling only, no WS subs.
- **Frontend activity feed**: `onLogs` has no reconnect logic. If WS drops, the live activity feed stops updating silently; historically-fetched records remain visible. The `?debug` query param logs `[ws-budget]` messages to the console to track active sub count.

## Railway Deployment

Meridian runs as a single Railway service `meridian`: one container serves the frontend SPA (via signal-server static file serving), runs automation cron, market-maker bots, and strategy bots.

### Setup

```bash
# 1. Fill in .env (copy from .env.example if first time)
cp .env.example .env
# Edit: DEVNET_RPC_URL, DEVNET_USDC_MINT, RAILWAY_SERVICE=meridian

# 2. Create Railway project + service (one-time)
railway init                # creates project, links to current dir
railway add -s meridian     # creates the service

# 3. First-time full deploy
make devnet-deploy    # build + deploy + USDC mint + GlobalConfig
make railway-env      # sync env vars to Railway service
make railway-deploy   # build + push container
```

### Redeployment

```bash
# Code changes only (frontend, bots, scripts)
make railway-deploy

# After contract changes (Rust)
make devnet-deploy && make railway-deploy

# After config changes (.env)
make railway-env && make railway-deploy
```

All bot activity is scoped to NVDA.

### Service Architecture

- Dockerfile: `Dockerfile` (root, multi-stage: builds frontend SPA, then runtime with scripts)
- Entrypoint: `entrypoint.sh`
- Runs five processes under `wait -n` (container restarts if any die):
  - automation cron (market creation at 8:00 AM ET + settlement at 4:07 PM ET)
  - signal-server (`scripts/signal-server.ts`, listens on `PORT`) - serves frontend SPA static files
  - seed-bots (long-running, re-seeds every 15 min during market hours)
  - live-bots (market maker, bot-a wallet)
  - strategy-bots (4 directional strategies, bot-b wallet) - starts **90s after live-bots** to stagger initial market discovery

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `VITE_RPC_URL` | Helius devnet RPC URL (baked into SPA at build time) |
| `VITE_USDC_MINT` | Devnet USDC mint address (baked into SPA at build time) |
| `VITE_DEV_WALLET` | `true` to enable auto-sign Dev Wallet |
| `USDC_MINT` | Devnet USDC mint address (runtime, for bots) |
| `ANCHOR_PROVIDER_URL` | Helius devnet RPC URL (runtime, for Anchor SDK + bots; `RPC_URL` is derived from this in `entrypoint.sh`) |
| `HERMES_URL` | `https://hermes-beta.pyth.network` for devnet-compatible Wormhole VAAs |
| `ALERT_WEBHOOK_URL` | Slack/Discord incoming webhook for automation failure alerts (optional) |
| `PORT` | Signal-server listen port (set by Railway automatically) |
| `RAILWAY_DOCKERFILE_PATH` | Set to `Dockerfile`; if auto-detect picks wrong file, also set in Railway dashboard: Settings > Build > Dockerfile Path |

## Current Frontend State

- **Landing** (`/`) - product explanation, live MAG7 Pyth prices, wallet connect CTA, settlement countdown. Featured contract card (nearest-ATM NVDA market) with Yes/No price bar and invariant display.
- **Markets** (`/markets`) - 7-ticker grid with live prices, strike counts, CLOB mid sparklines.
- **Market detail** (`/markets/:ticker`) - three-column layout: strike rail | order book + depth chart | trade panel + inline portfolio. Includes:
  - Lifecycle indicator (Created → Trading → Frozen → Settled step display)
  - Yes/No price bar (full variant in header, compact in strike rail)
  - Implied probability curve (SVG chart of yesMid across all strikes, clickable to select)
  - Depth chart (cumulative bid/ask stepped-area SVG below order book)
  - Solvency banner (vault pairs × $1.00 invariant check)
  - Settlement audit panel (oracle price, source, outcome - shown on settled markets)
  - Inline portfolio panel (ticker-scoped positions with redeem/exit buttons, below trade panel)
- **History** (`/history`) - on-chain instruction decoding. "My Trades" (connected wallet) or "All Activity" toggle. Cursor-based load-more pagination.
- **Portfolio** (`/portfolio`) - positions scoped to connected wallet. Mark value, cost basis, unrealized/realized P&L, redeem buttons for settled winners and pre-settlement complete sets.
- Header shows cluster label (Devnet/Localnet) and red banner when Phantom is on wrong network.

## Bot System

Three bot processes provide liquidity and trading activity. All are optional sidecars - the on-chain CLOB functions without them.

### Wallets

| Wallet | Role | Seed |
|--------|------|------|
| `admin` | USDC mint authority, program deployer | `sha256("meridian-dev-admin")` |
| `bot-a` | Market maker (live-bots, seed-bots) | `sha256("meridian-dev-bot-a")` |
| `bot-b` | Frontend dev wallet, strategy bots | `sha256("meridian-dev-bot-b")` |

### Processes

| Process | Wallet | Behavior | Cadence |
|---------|--------|----------|---------|
| **seed-bots** | bot-a | Bootstrap empty order books with logarithmic depth (6 bid/ask levels). Idempotent per market. | Loop every 15 min |
| **live-bots** | bot-a | Market maker: cancel/replace, place near spread, cross spread. Uniform random across NVDA strikes. | Tick every 150-400ms |
| **strategy-bots** | bot-b | Four directional strategies (momentum, Bollinger, correlation, time-decay). Taker-only. | Tick every 45s |

### Prices

Auto-detected from `ANCHOR_PROVIDER_URL`:
- **Localnet**: Synthetic random-walk (deterministic per process, no network deps)
- **Market hours** (9:30 AM-4:30 PM ET): Pyth Hermes HTTP; warns on fallback
- **Off-hours**: Pyth Hermes with silent fallback to synthetic

### WS Cache

Live-bots owns a single WS subscription, cycling through orderbooks round-robin every 10s. Writes parsed book state to `/tmp/meridian-ws-books.json`. Strategy-bots reads this file - no WS sub needed.

### Running Bots

```bash
# Local (separate terminals)
make local-live         # bot-a market maker
make local-strategy     # bot-b directional strategies
make local-seed         # bot-a one-shot book seeding

# Railway (feature flags in .env / railway-env)
ENABLE_LIQUIDITY_BOT=true   # starts seed-bots + live-bots
ENABLE_TRADE_BOTS=true      # starts strategy-bots (90s after live-bots)
```

### Funding

```bash
make devnet-fund-bots   # transfer SOL + mint 250K USDC to bot-a and bot-b
```

Bots auto-replenish USDC from admin mint authority when balance drops below threshold.

## Spec Deviations (Intentional)

Deviations from `spec.md` that are deliberate V1 scope decisions:

| Spec Requirement | Implementation | Rationale |
|---|---|---|
| Trade page | Integrated into MarketDetail (`/markets/:ticker`) | Trade panel lives inside market detail view |
| Settlement at ~4:05 PM ET via oracle | 4:07 PM ET, `settle_market` first then `admin_settle` fallback | Oracle path posts Wormhole-verified VAA from Hermes; falls back to `admin_settle` (1hr delay) if VAA outside settlement window or Hermes unavailable |
| Next.js for frontend | Vite + React | Lighter build, no SSR needed for SPA |
| Sell No limit orders | Market orders only | `buy_yes` + `redeem` composition requires fill before redeem. Spec describes Sell No as a taker action ("buys a Yes token from the ask side"), so this is spec-aligned. |

## Risks & Limitations

- **Devnet only** - no real funds, no mainnet deployment. Deterministic dev wallets (`sha256("meridian-dev-{name}")`) are in committed code; compromised if repo goes public.
- **Credit array cap**: 64 unique makers per order book. The 65th unique maker's transaction fails with `CreditLedgerFull`. Sufficient for bot-dominated alpha.
- **Oracle uses Pyth real-time price**, not the official NYSE/NASDAQ closing auction print. Settlement price at ~4:05 PM ET may differ from the official close.
- **Position constraints are frontend-only UX guardrails**. Tokens are freely transferable SPL tokens; on-chain, any wallet can hold both Yes and No simultaneously.
- **No protocol fees** in V1.
- **Alerting via webhook** - set `ALERT_WEBHOOK_URL` to a Slack or Discord incoming webhook URL to receive failure alerts from automation jobs. If unset, failures log to container logs only.
- **Frontend test coverage minimal** - one test file (`portfolio.test.ts`). Critical paths covered by validator-backed integration tests in `tests/`.

## Production Hardening Roadmap

This is a feature-complete interview demo on devnet. Below is what a real launch would require, organized by the gap between current demo scale and production multi-party markets (think NYSE equity options: thousands of participants, millions of contracts/day, sub-second matching).

### Order Book

The built-in CLOB is the right demo choice (shows depth of understanding, avoids Phoenix seat-approval complexity) but has hard limits designed for bot-dominated alpha:

| Dimension | Demo (current) | Production target |
|-----------|---------------|-------------------|
| Orders per side | 32 (fixed array) | 1,000+ per strike |
| Unique makers per book | 64 (credit array) | Unlimited |
| Matching | Fill-or-kill only | Partial fills, IOC, GTC |
| Order priority | Linear scan O(n) | Binary heap O(log n) |
| Book storage | Single zero_copy account (7.8 KB) | Sharded accounts or off-chain matching |

- [ ] **Dynamic order book sizing** - Replace fixed `[Order; 32]` arrays with a PDA-per-order model or linked-list pages. Current 7800-byte account fits in one Solana tx; production books need multi-account sharding (see Phoenix's approach with `MarketHeader` + separate `OrderPacket` pages).
- [ ] **Partial fills** - `buy_yes` and `sell_yes` currently require full fills (atomic fill-or-kill). Production needs partial fills with remaining quantity posted as a resting order. Requires rethinking the taker instruction to optionally place a maker order with the unfilled residual.
- [ ] **Order types** - Add IOC (immediate-or-cancel), GTC (good-till-cancel), and day orders. Current `place_order` is implicitly GTC with manual cancel.
- [ ] **Matching engine optimization** - Replace linear order scan with a sorted binary heap. Current O(n) iteration is fine for 32 slots; at 1,000+ orders it becomes a compute-unit bottleneck (~200k CU budget per Solana tx).
- [ ] **Sell No limit orders (auto-redeem on fill)** - Currently Sell No is market-only because `buy_yes` + `redeem` requires the fill to complete before redeem executes - impossible for resting orders where the fill happens in the taker's transaction. Fix: add `auto_redeem` flag on `Order` struct. During fill, if set, the program burns credited Yes + escrowed No directly and credits USDC instead of Yes tokens. Requires: new Order field (Borsh layout change), No token escrow vault on the OB, and fill handler access to Yes/No mints for burning. Maker still claims USDC via `claim_fills`. ~Half-day Rust change.

### Settlement & Oracle

- [ ] **Remove `admin_settle` on mainnet** - The admin fallback is a centralization risk. Production should use `settle_market` exclusively with multi-oracle redundancy (Pyth + Switchboard + Chainlink). `admin_settle` should be behind a multisig with a 24hr timelock, not a single admin key.
- [ ] **Official close price source** - Pyth's real-time equity feed at ~4:05 PM ET is *not* the official NYSE/NASDAQ closing auction print. Production needs either: (a) a dedicated closing-price oracle feed, or (b) a longer settlement window (e.g., settle after 4:30 PM when official close is published) with dispute resolution.
- [ ] **Multi-oracle aggregation** - Median of 3+ oracle sources to prevent single-feed manipulation. Current single-feed Pyth dependency is a liveness risk if Hermes goes down during settlement.
- [ ] **Settlement dispute window** - Add a challenge period (e.g., 30 min) where anyone can submit counter-evidence before settlement finalizes. Current settlement is instant and irreversible.
- [ ] **Mint-only freeze (keep CLOB live)** - `freeze_market` currently blocks all activity: minting, placing, taking, and cancelling. The exploit it prevents is post-close minting (mint pair after seeing the close price, sell the losing side). But the CLOB itself should stay open - if the close price is known, book prices converge naturally and no one sells the winning side cheap. Production should split the guard: `mint_pair` checks `status != Frozen`, trading instructions check `status != Settled`. This keeps price discovery alive during the 4:00-4:07 PM settlement window and matches how real exchanges work (halt issuance, not trading). ~30 min change (4 guard calls), no Borsh layout impact.
- [ ] **Account migration instruction** - Program upgrades that change `OrderBook` or `StrikeMarket` Borsh layout orphan existing accounts (Anchor's `AccountLoader` panics on size mismatch). Production needs a versioned `migrate_market(version)` instruction that reads the old layout, writes the new one, and reallocates if needed. Current devnet workaround: `make nuke --skip-settle --skip-close` and accept ~0.07 SOL/market rent loss.

### Risk & Compliance

- [ ] **On-chain position limits** - Current position constraints are frontend-only UX guardrails. Production needs program-enforced per-wallet and per-market limits to prevent concentration risk.
- [ ] **Circuit breakers** - The `pause` instruction exists but is admin-triggered. Production needs automated circuit breakers: halt trading if oracle price moves >10% intraday, or if order book spread exceeds threshold.
- [ ] **MEV protection** - Solana validators can reorder transactions. Production needs: priority fee management for time-sensitive settlements, and potentially a fair-ordering mechanism (Jito bundles or a sequenced inbox) to prevent front-running of large taker orders.
- [ ] **ZKP proof-of-performance ("Brag")** - Previously prototyped (`1754e0d`): Groth16 circuit via snarkjs/circom proving "I won >= N markets" against a Poseidon Merkle tree of settled positions, without revealing wallet address. Removed due to ~300MB dep weight from snarkjs. Revisit with a lighter ZK stack (e.g., SP1, Risc0) or move proof generation server-side to keep the frontend lean.

### Monetization

Protocol fees are currently zero. Revenue models used by comparable platforms:

- [ ] **Payout fee on winning redemptions (Polymarket model)** - Charge 1-2% in `redeem` only when the redeemed token matches the winning outcome. Losers pay nothing. Psychologically gentle, doesn't suppress trading volume. Implementation: ~10 lines in `redeem` - check settlement outcome, deduct fee to a `protocol_vault` PDA before USDC transfer. Note: traders can exit via CLOB sell at ~$0.98 to dodge the redemption fee; apply fee in `auto_credit_resting_orders` too to close the leak, or accept it as a liquidity incentive.
- [ ] **Maker-taker fee schedule (Kalshi model)** - Taker fee (2-5 bps) on `buy_yes`/`sell_yes` fills, negative maker fee (rebate) credited via `CreditEntry`. Standard exchange model. Requires sufficient organic volume to justify complexity.
- [ ] **Insurance fund** - Route protocol fees into an insurance vault to cover edge cases where the $1 payout invariant could be stressed by program bugs or oracle failures. Already referenced in Risk & Compliance above.

### Key Management

- [ ] **Deterministic wallets must go** - `sha256("meridian-dev-{name}")` wallets are in committed code. Production needs HSM-backed admin keys, multisig program authority (Squads), and separate hot/cold wallet infrastructure for bots.
- [ ] **Program upgrade authority** - Transfer to a multisig with timelock. Current single-admin upgrade authority is a rug risk.
- [ ] **USDC integration** - Replace custom devnet USDC mint with real USDC (mainnet mint authority is Circle). No mint-authority shenanigans possible with real USDC.

### Performance & Scalability

- [ ] **Compute unit budgeting** - Profile each instruction's CU consumption. `buy_yes` with 32-order book iteration currently uses ~100k CU; at scale this needs to stay under 200k to leave room for priority fees and Solana's 1.4M CU per-tx limit.
- [x] **RPC credit optimization** - On Helius free tier (1M credits/mo) bots burned ~248k credits/day. Fixed with three standard Solana bot practices: (a) `getBlockhashCached` with 30s TTL (blockhashes valid ~90s, was fetching per-tx - 54k credits/day wasted), (b) `skipPreflight: true` on all bot txs (simulation reads were 55k credits/day), (c) fire-and-forget `sendRawTransaction` + batch `getSignatureStatuses` instead of per-tx WS confirmation (25k WEBSOCKET_CONNECT credits/day). Provider monkey-patch in live-bots/strategy-bots applies to all `.rpc()` calls without per-site changes. Now on Developer plan ($49/mo, 50 req/s, 10M credits) - TX delay dropped from 2500ms to 500ms. Production would own the full tx lifecycle instead of patching Anchor's provider.
- **Frontend RPC hygiene** (current state: credit-aware, not a proxy layer):

  | Maturity | Description | Status |
  |----------|-------------|--------|
  | 0.0.1 | Naive - one RPC call per render, no batching | Past this |
  | **0.1** | **Batch reads (`getMultipleAccountsInfo`), polling over WS, inflight dedup** | **Current** |
  | 0.2 | Retry/circuit-breaker, adaptive polling, request coalescing | Not needed for demo |
  | 1.0 | Dedicated RPC, Geyser/webhooks, Jito bundles | Production infrastructure |

  Frontend has no RPC proxy or middleware - the `?debug` proxy is a console logger. Real optimization is architectural: 10s polling via `getMultipleAccountsInfo` (2 RPC calls vs 84 per-market WS subs), inflight dedup in activity feed (~20 lines), `Promise.allSettled` per Pyth feed (Hermes batch is all-or-nothing). Zero WS subs for market data; 1 `onLogs` sub for activity feed. This is the right amount of complexity for a devnet demo.

- [ ] **Transaction pipelining** - Combine sequenced operations (cancel+replace, mint+place) into single atomic transactions. Current fire-and-forget pattern accepts that sequenced ops occasionally fail when the first tx doesn't land - bot retries on next tick. Production needs: nonce accounts for guaranteed inclusion, atomic cancel+replace instructions, and per-block write-lock contention handling when multiple takers hit the same order book.
- [ ] **RPC infrastructure** - Current Helius Developer plan (50 req/s, 10M credits/mo) is sufficient for devnet demo. Production market makers need dedicated RPC nodes with sub-100ms latency. Jito bundles for MEV-protected settlement transactions.
- [ ] **Event indexing** - Replace frontend `onLogs` polling with a dedicated indexer (Helius webhooks, or a custom Geyser plugin) for reliable trade history and analytics.

### Monitoring & Operations

- [ ] **Structured logging** - Replace `console.log` bot output with structured JSON logs (pino/winston) feeding into a log aggregator.
- [ ] **Metrics** - Instrument: order fill rate, settlement latency, oracle staleness, book depth, maker P&L. Export to Prometheus/Grafana.
- [ ] **Automated market creation** - Current `setup-devnet` is semi-manual. Production needs a fully autonomous morning job that creates markets based on previous close (already partially built in `scripts/automation.ts`), handles holidays/half-days, and validates strike generation.
- [ ] **Graceful degradation** - If bots crash, markets should still function (they do - CLOB is on-chain). But front-end needs to clearly indicate when market-maker liquidity is absent.

### What's Already Production-Ready

Not everything needs rework. These components are designed for scale:

- **Credit/claim settlement model** - Taker txs are fully deterministic (no `remaining_accounts` variance). This is the key architectural win over Phoenix/OpenBook where taker txs can fail due to stale book state.
- **$1 payout invariant** - Enforced at the Rust level with overflow-checked arithmetic. Every code path preserves `total_pairs_minted * USDC_PER_PAIR == vault_balance`.
- **State machine** - Created → Frozen → Settled transitions are well-tested with 118 integration tests covering edge cases, double-settlement prevention, and concurrent access patterns.
- **Oracle integration** - `settle_market` with Pyth pull-based oracle (PriceUpdateV2 via Wormhole VAA) is the production path. Staleness and confidence checks are configurable per ticker.
- **Short-cycle markets** - `make local` creates 12-minute markets for rapid local iteration. `make local-cycle` rotates to fresh markets. `make uat` runs the full lifecycle end-to-end.

## Notes

- Local validator state lives under `.localnet/`.
- Program ID is deterministic: `GMwKXYNKRkN3wGdgAwR4BzG2RfPGGLGjehuoNwUzBGk2`
- Strikes: rounded close plus `±3%`, `±6%`, `±9%` offsets, rounded to nearest `$10`, deduplicated (up to 7 per ticker).
