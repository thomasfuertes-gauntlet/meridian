.PHONY: dev dev-frontend dev-validator deploy setup wallets bots live strategy-bots test check clean circuit tree deploy-devnet setup-devnet wallet-pubkeys health settle morning reset

# Source Solana/Rust toolchain (Anza installer, not Homebrew - brew's solana lacks build-sbf)
export PATH := $(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.cargo/bin:$(PATH)

# Dev wallet path (deterministic, per-project)
ADMIN_WALLET := .wallets/admin.json

# Devnet config (single source of truth)
DEVNET_URL ?= https://api.devnet.solana.com
DEVNET_USDC_MINT ?= AKmi2ZrBwWi49xf5EdvVRB7679QM7wSVGxPMbFKZ7rqE

# Local development: wallets + validator + deploy + seed + frontend
dev: wallets dev-validator deploy setup dev-frontend

# Generate deterministic dev wallets (idempotent)
wallets:
	@npx tsx scripts/dev-wallets.ts

# Start local validator in background (kills existing)
dev-validator:
	@echo "Starting local validator..."
	@pkill -f solana-test-validator 2>/dev/null || true
	@sleep 1
	solana-test-validator --reset --limit-ledger-size 50000000 > /dev/null 2>&1 &
	@echo "Waiting for validator..."
	@sleep 5
	@solana config set --url localhost

# Build and deploy to local validator
# Fund admin wallet first (deterministic wallet starts empty, deploy costs ~3.8 SOL).
# anchor deploy exits non-zero if IDL account upload fails (race condition
# with local validator). The program itself deploys fine - ignore the error.
deploy:
	@echo "Funding admin wallet..."
	@solana airdrop 5 $(shell solana-keygen pubkey $(ADMIN_WALLET)) > /dev/null 2>&1 || true
	@solana airdrop 5 $(shell solana-keygen pubkey $(ADMIN_WALLET)) > /dev/null 2>&1 || true
	@echo "Building program..."
	anchor build
	@cp target/idl/meridian.json app/src/idl/meridian.json
	@echo "Deploying to local validator..."
	anchor deploy --provider.cluster localnet --no-idl

# Run setup script (pass WALLET=<pubkey> to fund a browser wallet)
setup:
	@echo "Setting up markets..."
	OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/setup-local.ts $(WALLET)

# Start frontend dev server (foreground). Bots seed + live trade in background.
# Pass OFFLINE=1 to use synthetic prices (for weekends/off-hours dev).
dev-frontend:
	@npm ci --prefix app --silent
	@echo "Seeding bots + starting live trader in background..."
	@( OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/seed-bots.ts && \
	   OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/live-bots.ts ) > /tmp/meridian-bots.log 2>&1 &
	@( sleep 30 && OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/strategy-bots.ts ) >> /tmp/meridian-bots.log 2>&1 &
	@echo "Bot logs: /tmp/meridian-bots.log"
	@echo "Starting frontend..."
	npm run dev --prefix app

# Seed order books with bot liquidity (run after setup)
bots:
	@echo "Seeding order books with bot liquidity..."
	OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/seed-bots.ts

# Run live trading bot (continuous order book movement)
live:
	@echo "Starting live trading bot (Ctrl+C to stop)..."
	OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/live-bots.ts

# Run strategy bots (directional traders using bot-b wallet)
strategy-bots:
	@echo "Starting strategy bots (Ctrl+C to stop)..."
	OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/strategy-bots.ts

# Deploy to devnet (fund admin wallet first: solana airdrop 2 <admin-pubkey> --url devnet)
deploy-devnet: wallets
	@echo "Admin pubkey: $(shell solana-keygen pubkey $(ADMIN_WALLET))"
	anchor build
	@cp target/idl/meridian.json app/src/idl/meridian.json
	anchor deploy --provider.cluster devnet --provider.wallet $(ADMIN_WALLET)

# Setup devnet markets + USDC mint (run once after deploy-devnet)
setup-devnet: wallets
	@echo "Setting up devnet markets..."
	ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/setup-devnet.ts

# Devnet health check - balances, markets, actionable warnings
health: wallets
	@ANCHOR_PROVIDER_URL=$(DEVNET_URL) ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/health-check.ts

# Print dev wallet pubkeys (for faucet funding)
wallet-pubkeys: wallets
	@echo "Admin: $(shell solana-keygen pubkey .wallets/admin.json)"
	@echo "Bot-A: $(shell solana-keygen pubkey .wallets/bot-a.json)"
	@echo "Bot-B: $(shell solana-keygen pubkey .wallets/bot-b.json)"

# Settle devnet markets (one-shot, uses admin_settle + Pyth Hermes)
settle: wallets
	@echo "Running settlement job against devnet..."
	cd automation && RPC_URL=$(DEVNET_URL) USDC_MINT=$(DEVNET_USDC_MINT) \
		ADMIN_KEYPAIR_PATH=../.wallets/admin.json \
		npx tsx src/index.ts --settle

# Create today's markets via automation morning job (one-shot)
morning: wallets
	@echo "Running morning job against devnet..."
	cd automation && RPC_URL=$(DEVNET_URL) USDC_MINT=$(DEVNET_USDC_MINT) \
		ADMIN_KEYPAIR_PATH=../.wallets/admin.json \
		npx tsx src/index.ts --now

# Run tests (local validator started by anchor test)
test: wallets
	anchor test

## Pre-push smoke test: contract tests + frontend build + lint
check: wallets
	@echo "=== Anchor tests ==="
	anchor test
	@echo ""
	@echo "=== Frontend build ==="
	VITE_USDC_MINT="11111111111111111111111111111111" npm run build --prefix app
	@echo ""
	@echo "=== Lint ==="
	npm run lint --prefix app
	@echo ""
	@echo "=== All checks passed ==="

# Build ZK circuit artifacts (one-time, requires circom: cargo install circom)
circuit:
	cd circuits && ./build.sh

# Build Poseidon Merkle tree from settled markets
tree:
	ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/build-tree.ts

# Devnet reset: settle stale markets, create today's, seed bots
reset: wallets settle morning
	@echo "Seeding devnet order books..."
	ANCHOR_PROVIDER_URL=$(DEVNET_URL) ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/seed-bots.ts
	@echo ""
	@echo "=== Reset complete ==="
	@echo "  - Stale markets settled"
	@echo "  - Today's markets created"
	@echo "  - Order books seeded"
	@echo ""
	@echo "Next: railway up -s bots -d && railway up app --path-as-root -s frontend -d"

# Clean up
clean:
	@pkill -f solana-test-validator 2>/dev/null || true
	@pkill -f seed-bots 2>/dev/null || true
	@pkill -f live-bots 2>/dev/null || true
	@pkill -f strategy-bots 2>/dev/null || true
	@echo "Validator and bots stopped"
