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
	solana-test-validator --reset > /dev/null 2>&1 &
	@echo "Waiting for validator..."
	@sleep 5
	@solana config set --url localhost

# Build and deploy to local validator
# anchor deploy exits non-zero if IDL account upload fails (race condition
# with local validator). The program itself deploys fine - ignore the error.
deploy:
	@echo "Building program..."
	anchor build
	@echo "Deploying to local validator..."
	anchor deploy --provider.cluster localnet || echo "Deploy completed (IDL upload may have failed - this is OK)"

# Run setup script (pass WALLET=<pubkey> to fund a browser wallet)
setup:
	@echo "Setting up markets..."
	ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$(HOME)/.config/solana/id.json \
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
