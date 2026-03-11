.PHONY: \
	wallets \
	local local-full local-validator local-validator-stop local-validator-reset \
	local-deploy local-setup local-bots local-live local-strategy \
	local-test-rust local-test-anchor local-check \
	devnet-deploy devnet-setup devnet-health devnet-settle devnet-morning devnet-reset \
	wallet-pubkeys circuit tree clean \
	dev dev-validator deploy setup bots live strategy-bots test check \
	deploy-devnet setup-devnet health settle morning reset

# Toolchain from the Solana installer plus cargo.
export PATH := $(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.cargo/bin:$(PATH)

ADMIN_WALLET := .wallets/admin.json

LOCAL_RPC_URL ?= http://127.0.0.1:8899
LOCAL_WS_URL ?= ws://127.0.0.1:8900
LOCAL_LEDGER_DIR ?= .localnet/ledger
LOCAL_VALIDATOR_LOG ?= .localnet/validator.log
LOCAL_VALIDATOR_PID ?= .localnet/validator.pid
LOCAL_BOT_LOG ?= .localnet/bots.log

DEVNET_URL ?= https://api.devnet.solana.com
DEVNET_USDC_MINT ?= AKmi2ZrBwWi49xf5EdvVRB7679QM7wSVGxPMbFKZ7rqE

wallets:
	@npx tsx scripts/dev-wallets.ts

local: wallets local-validator local-deploy

# This keeps the older "bring everything up" behavior available, but it is no
# longer the default because the local TS setup/bot surface is not the most
# reliable validation path today.
local-full: local local-setup local-bots

local-validator:
	@mkdir -p .localnet
	@if [ -f "$(LOCAL_VALIDATOR_PID)" ] && kill -0 "$$(cat $(LOCAL_VALIDATOR_PID))" 2>/dev/null; then \
		echo "Local validator already running (pid $$(cat $(LOCAL_VALIDATOR_PID)))"; \
	else \
		echo "Starting local validator..."; \
		solana-test-validator \
			--reset \
			--ledger "$(LOCAL_LEDGER_DIR)" \
			--limit-ledger-size 50000000 \
			> "$(LOCAL_VALIDATOR_LOG)" 2>&1 & \
		echo $$! > "$(LOCAL_VALIDATOR_PID)"; \
		echo "Waiting for validator on $(LOCAL_RPC_URL)..."; \
		sleep 5; \
	fi

local-validator-stop:
	@if [ -f "$(LOCAL_VALIDATOR_PID)" ] && kill -0 "$$(cat $(LOCAL_VALIDATOR_PID))" 2>/dev/null; then \
		echo "Stopping local validator (pid $$(cat $(LOCAL_VALIDATOR_PID)))"; \
		kill "$$(cat $(LOCAL_VALIDATOR_PID))"; \
		rm -f "$(LOCAL_VALIDATOR_PID)"; \
	else \
		echo "No tracked local validator is running"; \
	fi

local-validator-reset: local-validator-stop
	@rm -rf .localnet

local-deploy: wallets local-validator
	@mkdir -p .localnet
	@echo "Funding admin wallet on local validator..."
	@solana airdrop 5 "$$(solana-keygen pubkey $(ADMIN_WALLET))" --url "$(LOCAL_RPC_URL)" > /dev/null
	@solana airdrop 5 "$$(solana-keygen pubkey $(ADMIN_WALLET))" --url "$(LOCAL_RPC_URL)" > /dev/null
	@echo "Building program..."
	anchor build
	@cp target/idl/meridian.json app/src/idl/meridian.json
	@echo "Deploying to local validator..."
	anchor deploy --provider.cluster localnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

# Local TS setup is intentionally opt-in until that surface is refreshed.
local-setup: wallets
	@echo "Running local setup script against $(LOCAL_RPC_URL)..."
	@echo "Note: scripts/setup-local.ts is currently stale relative to the latest market close-time rules."
	ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" OFFLINE="$(OFFLINE)" \
		npx tsx scripts/setup-local.ts $(WALLET)

local-bots: wallets
	@mkdir -p .localnet
	@echo "Seeding local order books..."
	ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" OFFLINE="$(OFFLINE)" \
		npx tsx scripts/seed-bots.ts

local-live: wallets
	@echo "Starting local live bot..."
	ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" OFFLINE="$(OFFLINE)" \
		npx tsx scripts/live-bots.ts

local-strategy: wallets
	@echo "Starting local strategy bots..."
	ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" OFFLINE="$(OFFLINE)" \
		npx tsx scripts/strategy-bots.ts

local-test-rust:
	cargo test -p meridian

local-test-anchor: wallets
	anchor test --skip-build

local-check: local-test-rust
	@echo ""
	@echo "Local Rust checks passed"

devnet-deploy: wallets
	@echo "Admin pubkey: $$(solana-keygen pubkey $(ADMIN_WALLET))"
	anchor build
	@cp target/idl/meridian.json app/src/idl/meridian.json
	anchor deploy --provider.cluster devnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

# Devnet should be static. Reuse the configured mint instead of silently creating
# a new one each run.
devnet-setup: wallets
	@echo "Setting up devnet markets with static USDC mint $(DEVNET_USDC_MINT)..."
	ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" USDC_MINT="$(DEVNET_USDC_MINT)" \
		npx tsx scripts/setup-devnet.ts

devnet-health: wallets
	ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" \
		npx tsx scripts/health-check.ts

devnet-settle: wallets
	@echo "Running settlement job against devnet..."
	cd automation && RPC_URL="$(DEVNET_URL)" USDC_MINT="$(DEVNET_USDC_MINT)" \
		ADMIN_KEYPAIR_PATH=../.wallets/admin.json \
		npx tsx src/index.ts --settle

devnet-morning: wallets
	@echo "Running morning job against devnet..."
	cd automation && RPC_URL="$(DEVNET_URL)" USDC_MINT="$(DEVNET_USDC_MINT)" \
		ADMIN_KEYPAIR_PATH=../.wallets/admin.json \
		npx tsx src/index.ts --now

devnet-reset: wallets devnet-settle devnet-morning
	@echo "Seeding devnet order books..."
	ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" \
		npx tsx scripts/seed-bots.ts

wallet-pubkeys: wallets
	@echo "Admin: $$(solana-keygen pubkey .wallets/admin.json)"
	@echo "Bot-A: $$(solana-keygen pubkey .wallets/bot-a.json)"
	@echo "Bot-B: $$(solana-keygen pubkey .wallets/bot-b.json)"

circuit:
	cd circuits && ./build.sh

tree:
	ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" \
		npx tsx scripts/build-tree.ts

clean: local-validator-stop
	@pkill -f "/seed-bots.ts" 2>/dev/null || true
	@pkill -f "/live-bots.ts" 2>/dev/null || true
	@pkill -f "/strategy-bots.ts" 2>/dev/null || true
	@echo "Stopped tracked local validator and local bot processes"

# Compatibility aliases. Keep the old names, but point them at the safer layout.
dev: local-full
dev-validator: local-validator
deploy: local-deploy
setup: local-setup
bots: local-bots
live: local-live
strategy-bots: local-strategy
test: local-test-anchor
check: local-check
deploy-devnet: devnet-deploy
setup-devnet: devnet-setup
health: devnet-health
settle: devnet-settle
morning: devnet-morning
reset: devnet-reset
