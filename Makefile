.PHONY: dev dev-frontend dev-validator deploy setup test clean

# Source Solana/Rust toolchain
export PATH := $(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.cargo/bin:$(PATH)

# Local development: validator + deploy + seed + frontend
dev: dev-validator deploy setup dev-frontend

# Start local validator in background (kills existing)
dev-validator:
	@echo "Starting local validator..."
	@pkill -f solana-test-validator 2>/dev/null || true
	@sleep 1
	solana-test-validator --reset --quiet &
	@echo "Waiting for validator..."
	@sleep 3
	@solana config set --url localhost --quiet

# Build and deploy to local validator
deploy:
	@echo "Building program..."
	anchor build
	@echo "Deploying to local validator..."
	anchor deploy --provider.cluster localnet

# Run setup script (pass WALLET=<pubkey> to fund a browser wallet)
setup:
	@echo "Setting up markets..."
	npx ts-mocha --timeout 60000 --require ts-node/register scripts/setup-local.ts $(WALLET) 2>/dev/null || \
		npx tsx scripts/setup-local.ts $(WALLET)

# Start frontend dev server
dev-frontend:
	@echo "Starting frontend..."
	npm run dev --prefix app

# Deploy to devnet
deploy-devnet:
	anchor build
	anchor deploy --provider.cluster devnet

# Run tests (local validator started by anchor test)
test:
	anchor test

# Clean up
clean:
	@pkill -f solana-test-validator 2>/dev/null || true
	@echo "Validator stopped"
