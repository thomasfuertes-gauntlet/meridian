.PHONY: dev dev-frontend dev-validator deploy setup wallets bots live test clean circuit tree deploy-devnet setup-devnet wallet-pubkeys health

# Source Solana/Rust toolchain
export PATH := $(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.cargo/bin:$(PATH)

# Dev wallet path (deterministic, per-project)
ADMIN_WALLET := .wallets/admin.json

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
	@echo "Deploying to local validator..."
	anchor deploy --provider.cluster localnet || echo "Deploy completed (IDL upload may have failed - this is OK)"

# Run setup script (pass WALLET=<pubkey> to fund a browser wallet)
setup:
	@echo "Setting up markets..."
	OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/setup-local.ts $(WALLET)

# Start frontend dev server (foreground). Bots seed + live trade in background.
# Pass OFFLINE=1 to use synthetic prices (for weekends/off-hours dev).
dev-frontend:
	@echo "Seeding bots + starting live trader in background..."
	@( OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/seed-bots.ts && \
	   OFFLINE=$(OFFLINE) ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/live-bots.ts ) > /dev/null 2>&1 &
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

# Deploy to devnet (fund admin wallet first: solana airdrop 2 <admin-pubkey> --url devnet)
deploy-devnet: wallets
	@echo "Admin pubkey: $(shell solana-keygen pubkey $(ADMIN_WALLET))"
	anchor build
	anchor deploy --provider.cluster devnet --provider.wallet $(ADMIN_WALLET)

# Setup devnet markets + USDC mint (run once after deploy-devnet)
setup-devnet: wallets
	@echo "Setting up devnet markets..."
	ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/setup-devnet.ts

# Devnet health check - balances, markets, actionable warnings
health: wallets
	@ANCHOR_PROVIDER_URL=$${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com} \
		ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/health-check.ts

# Print dev wallet pubkeys (for faucet funding)
wallet-pubkeys: wallets
	@echo "Admin: $(shell solana-keygen pubkey .wallets/admin.json)"
	@echo "Bot-A: $(shell solana-keygen pubkey .wallets/bot-a.json)"
	@echo "Bot-B: $(shell solana-keygen pubkey .wallets/bot-b.json)"

# Run tests (local validator started by anchor test)
test: wallets
	anchor test

# Build ZK circuit artifacts (one-time, requires circom: cargo install circom)
circuit:
	cd circuits && ./build.sh

# Build Poseidon Merkle tree from settled markets
tree:
	ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(ADMIN_WALLET) \
		npx tsx scripts/build-tree.ts

# Clean up
clean:
	@pkill -f solana-test-validator 2>/dev/null || true
	@pkill -f seed-bots 2>/dev/null || true
	@pkill -f live-bots 2>/dev/null || true
	@echo "Validator and bots stopped"
