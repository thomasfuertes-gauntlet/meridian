.PHONY: \
	build wallets \
	local local-full local-validator local-validator-stop local-validator-reset \
	local-deploy local-setup local-bots local-live local-strategy \
	local-test-rust local-test-anchor local-test-smoke local-check \
	devnet-deploy devnet-setup devnet-health devnet-settle devnet-morning devnet-reset \
	wallet-pubkeys circuit tree clean \
	dev dev-validator deploy setup bots live strategy-bots test check \
	deploy-devnet setup-devnet health settle morning reset

# Toolchain from the Solana installer plus cargo.
export PATH := $(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.cargo/bin:$(PATH)

ADMIN_WALLET := .wallets/admin.json
BOT_A_WALLET := .wallets/bot-a.json
BOT_B_WALLET := .wallets/bot-b.json
APP_IDL_PATH := app/src/idl/meridian.json

LOCAL_STATE_DIR ?= .localnet
LOCAL_RPC_URL ?= http://127.0.0.1:8899
LOCAL_WS_URL ?= ws://127.0.0.1:8900
LOCAL_LEDGER_DIR ?= $(LOCAL_STATE_DIR)/ledger
LOCAL_VALIDATOR_LOG ?= $(LOCAL_STATE_DIR)/validator.log
LOCAL_VALIDATOR_PID ?= $(LOCAL_STATE_DIR)/validator.pid
LOCAL_BOT_LOG ?= $(LOCAL_STATE_DIR)/bots.log

DEVNET_URL ?= https://api.devnet.solana.com
DEVNET_USDC_MINT ?= AKmi2ZrBwWi49xf5EdvVRB7679QM7wSVGxPMbFKZ7rqE

ADMIN_PUBKEY = $$(solana-keygen pubkey $(ADMIN_WALLET))
LOCAL_TS_ENV = ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" OFFLINE="$(OFFLINE)"
LOCAL_TEST_ENV = ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)"
DEVNET_READONLY_ENV = ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)"
DEVNET_TS_ENV = ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" USDC_MINT="$(DEVNET_USDC_MINT)"
DEVNET_AUTOMATION_ENV = RPC_URL="$(DEVNET_URL)" USDC_MINT="$(DEVNET_USDC_MINT)" ADMIN_KEYPAIR_PATH=../$(ADMIN_WALLET)
SMOKE_TEST_GREP = roundtrips create -> freeze -> settle-with-proof -> redeem against config-backed oracle policy

wallets:
	@npx tsx scripts/dev-wallets.ts

build:
	anchor build
	@cp target/idl/meridian.json $(APP_IDL_PATH)

local: local-deploy

# This keeps the older "bring everything up" behavior available, but it is no
# longer the default because the local TS setup/bot surface is not the most
# reliable validation path today.
local-full: local local-setup local-bots

local-validator:
	@mkdir -p $(LOCAL_STATE_DIR)
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
	@rm -rf $(LOCAL_STATE_DIR)

local-deploy: wallets local-validator
	@mkdir -p $(LOCAL_STATE_DIR)
	@echo "Funding admin wallet on local validator..."
	@solana airdrop 5 "$(ADMIN_PUBKEY)" --url "$(LOCAL_RPC_URL)" > /dev/null
	@solana airdrop 5 "$(ADMIN_PUBKEY)" --url "$(LOCAL_RPC_URL)" > /dev/null
	@echo "Building program and refreshing IDL..."
	@$(MAKE) build
	@echo "Deploying to local validator..."
	anchor deploy --provider.cluster localnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

# Local TS setup is intentionally opt-in until that surface is refreshed.
local-setup: wallets
	@echo "Running local setup script against $(LOCAL_RPC_URL)..."
	@echo "Note: scripts/setup-local.ts is currently stale relative to the latest market close-time rules."
	$(LOCAL_TS_ENV) npx tsx scripts/setup-local.ts $(WALLET)

local-bots: wallets
	@mkdir -p $(LOCAL_STATE_DIR)
	@echo "Seeding local order books..."
	$(LOCAL_TS_ENV) npx tsx scripts/seed-bots.ts

local-live: wallets
	@echo "Starting local live bot..."
	$(LOCAL_TS_ENV) npx tsx scripts/live-bots.ts

local-strategy: wallets
	@echo "Starting local strategy bots..."
	$(LOCAL_TS_ENV) npx tsx scripts/strategy-bots.ts

local-test-rust:
	cargo test -p meridian

local-test-anchor: wallets
	anchor test --skip-build

local-test-smoke: local-deploy
	@echo "Running targeted validator-backed roundtrip smoke test..."
	$(LOCAL_TEST_ENV) npm test -- --grep "$(SMOKE_TEST_GREP)"

local-check: local-test-rust
	@echo ""
	@echo "Local Rust checks passed"

devnet-deploy: wallets
	@echo "Admin pubkey: $(ADMIN_PUBKEY)"
	@$(MAKE) build
	anchor deploy --provider.cluster devnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

# Devnet should be static. Reuse the configured mint instead of silently creating
# a new one each run.
devnet-setup: wallets
	@echo "Setting up devnet markets with static USDC mint $(DEVNET_USDC_MINT)..."
	$(DEVNET_TS_ENV) npx tsx scripts/setup-devnet.ts

devnet-health: wallets
	$(DEVNET_READONLY_ENV) npx tsx scripts/health-check.ts

devnet-settle: wallets
	@echo "Running settlement job against devnet..."
	cd automation && $(DEVNET_AUTOMATION_ENV) npx tsx src/index.ts --settle

devnet-morning: wallets
	@echo "Running morning job against devnet..."
	cd automation && $(DEVNET_AUTOMATION_ENV) npx tsx src/index.ts --now

devnet-reset: wallets devnet-settle devnet-morning
	@echo "Seeding devnet order books..."
	$(DEVNET_READONLY_ENV) npx tsx scripts/seed-bots.ts

wallet-pubkeys: wallets
	@echo "Admin: $$(solana-keygen pubkey $(ADMIN_WALLET))"
	@echo "Bot-A: $$(solana-keygen pubkey $(BOT_A_WALLET))"
	@echo "Bot-B: $$(solana-keygen pubkey $(BOT_B_WALLET))"

circuit:
	cd circuits && ./build.sh

tree:
	$(LOCAL_TS_ENV) npx tsx scripts/build-tree.ts

clean: local-validator-stop
	@for script in seed-bots.ts live-bots.ts strategy-bots.ts; do \
		pkill -f "/$$script" 2>/dev/null || true; \
	done
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
