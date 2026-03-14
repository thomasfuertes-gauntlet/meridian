.PHONY: \
	build wallets bootstrap-fresh \
	local local-full local-validator local-validator-stop local-validator-reset \
	local-rpc-check local-bootstrap local-validator-live \
	local-deploy local-setup local-bots local-live local-strategy local-ui-ready local-ui \
	local-test-rust local-test-anchor local-test-smoke local-test-grep local-check \
	devnet-env-check railway-env-check railway-sync \
	railway-deploy-frontend railway-deploy-bots railway-deploy railway-release \
	devnet-deploy devnet-setup devnet-health devnet-settle devnet-morning devnet-reset \
	wallet-pubkeys clean \
	alpha-cycle alpha-settle alpha-seed \
	dev dev-validator deploy setup bots live strategy-bots test check \
	deploy-devnet setup-devnet health settle morning reset \
	alpha-nuke alpha-full-reset

# Toolchain from the Solana installer plus cargo.
export PATH := $(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.cargo/bin:$(PATH)

-include config/devnet.env

ADMIN_WALLET ?= .wallets/admin.json
BOT_A_WALLET ?= .wallets/bot-a.json
BOT_B_WALLET ?= .wallets/bot-b.json
PROGRAM_KEYPAIR ?= target/deploy/meridian-keypair.json
APP_IDL_PATH := frontend/src/idl/meridian.json

LOCAL_STATE_DIR ?= .localnet
LOCAL_RPC_URL ?= http://127.0.0.1:8899
LOCAL_WS_URL ?= ws://127.0.0.1:8900
LOCAL_LEDGER_DIR ?= $(LOCAL_STATE_DIR)/ledger
LOCAL_VALIDATOR_LOG ?= $(LOCAL_STATE_DIR)/validator.log
LOCAL_VALIDATOR_PID ?= $(LOCAL_STATE_DIR)/validator.pid
LOCAL_BOT_LOG ?= $(LOCAL_STATE_DIR)/bots.log
LOCAL_VALIDATOR_BOOT_WAIT ?= 30
# KEY-DECISION 2026-03-13: use 'node --import tsx' not the 'tsx' CLI.
# The tsx CLI opens an IPC pipe that hits EPERM in sandboxed/non-interactive shells.
TSX ?= node --import tsx

DEVNET_URL ?= $(DEVNET_RPC_URL)
RAILWAY_FRONTEND_SERVICE ?= frontend
RAILWAY_BOTS_SERVICE ?= bots
RAILWAY_BOTS_URL ?= $(RAILWAY_BOTS_PUBLIC_URL)
VITE_DEV_WALLET ?= true
DEMO_TICKER ?= NVDA


ADMIN_PUBKEY = $$(solana-keygen pubkey $(ADMIN_WALLET))
LOCAL_TS_ENV = ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" OFFLINE="$(OFFLINE)" DEMO_TICKER="$(DEMO_TICKER)"
LOCAL_TEST_ENV = ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)"
DEVNET_READONLY_ENV = ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)"
DEVNET_TS_ENV = ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" USDC_MINT="$(DEVNET_USDC_MINT)"
DEVNET_AUTOMATION_ENV = RPC_URL="$(DEVNET_URL)" USDC_MINT="$(DEVNET_USDC_MINT)" ADMIN_KEYPAIR_PATH=../$(ADMIN_WALLET)
SMOKE_TEST_GREP = roundtrips create -> freeze -> settle-with-proof -> redeem against config-backed oracle policy

define require_var
	@if [ -z "$($1)" ]; then \
		echo "Missing required config: $1"; \
		echo "Set it in config/devnet.env, export it in your shell, or pass it inline."; \
		if [ -f config/devnet.env.example ]; then \
			echo "Start from: cp config/devnet.env.example config/devnet.env"; \
		fi; \
		exit 1; \
	fi
endef

define require_any_var
	@if [ -z "$($1)" ] && [ -z "$($2)" ]; then \
		echo "Missing required config: $1 or $2"; \
		echo "Set one of them in config/devnet.env, export it in your shell, or pass it inline."; \
		if [ -f config/devnet.env.example ]; then \
			echo "Start from: cp config/devnet.env.example config/devnet.env"; \
		fi; \
		exit 1; \
	fi
endef

wallets:
	@$(TSX) scripts/dev-wallets.ts

bootstrap-fresh:
	@echo "=== Meridian Fresh Bootstrap ==="
	@echo "Generating fresh keypairs..."
	WALLET_MODE=generate $(TSX) scripts/dev-wallets.ts
	@echo "Patching program ID..."
	$(TSX) scripts/patch-program-id.ts
	@echo "Building..."
	@$(MAKE) build
	@echo "Starting local validator..."
	@$(MAKE) local-validator
	@echo "Deploying..."
	anchor deploy --provider.cluster localnet --provider.wallet "$(ADMIN_WALLET)" --no-idl
	@echo "Running setup..."
	OFFLINE=1 ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" $(TSX) scripts/setup-local.ts
	@echo "Seeding order books..."
	OFFLINE=1 ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" $(TSX) scripts/seed-bots.ts
	@echo ""
	@echo "=== Bootstrap Complete ==="
	@echo "Program ID: $$($(TSX) -e 'import{Keypair}from\"@solana/web3.js\";import*as fs from\"fs\";const kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(\"$(PROGRAM_KEYPAIR)\",\"utf-8\"))));console.log(kp.publicKey.toString())')"
	@echo "Admin: $$(solana-keygen pubkey $(ADMIN_WALLET))"

build:
	anchor build
	@cp target/idl/meridian.json $(APP_IDL_PATH)

local: local-deploy

local-rpc-check:
	@if ! solana cluster-version --url "$(LOCAL_RPC_URL)" >/dev/null 2>&1; then \
		echo "Local validator is not reachable at $(LOCAL_RPC_URL)"; \
		echo "Start it in a dedicated terminal with:"; \
		echo "  make local-validator-live"; \
		exit 1; \
	fi

local-bootstrap: wallets local-rpc-check
	@echo "Building program and refreshing IDL..."
	@$(MAKE) build
	@echo "Deploying to running local validator..."
	anchor deploy --provider.cluster localnet --provider.wallet "$(ADMIN_WALLET)" --no-idl
	@echo "Running local setup..."
	OFFLINE=1 ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" $(TSX) scripts/setup-local.ts $(WALLET)
	@echo "Seeding local order books..."
	OFFLINE=1 ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" $(TSX) scripts/seed-bots.ts

local-validator-live:
	solana-test-validator --bind-address 127.0.0.1 --mint "$(ADMIN_PUBKEY)" --reset --ledger "$(LOCAL_LEDGER_DIR)" --limit-ledger-size 50000000

# This keeps the older "bring everything up" behavior available, but it is no
# longer the default because the local TS setup/bot surface is not the most
# reliable validation path today.
local-full: local local-setup local-bots

local-validator:
	@mkdir -p $(LOCAL_STATE_DIR)
	@if [ -f "$(LOCAL_VALIDATOR_PID)" ] && kill -0 "$$(cat $(LOCAL_VALIDATOR_PID))" 2>/dev/null; then \
		if solana cluster-version --url "$(LOCAL_RPC_URL)" >/dev/null 2>&1; then \
			echo "Local validator already running (pid $$(cat $(LOCAL_VALIDATOR_PID)))"; \
		else \
			echo "Tracked validator pid $$(cat $(LOCAL_VALIDATOR_PID)) exists but RPC is unhealthy; restarting"; \
			kill "$$(cat $(LOCAL_VALIDATOR_PID))" 2>/dev/null || true; \
			rm -f "$(LOCAL_VALIDATOR_PID)"; \
			echo "Starting local validator..."; \
			nohup solana-test-validator \
				--bind-address 127.0.0.1 \
				--faucet-port 0 \
				--mint "$(ADMIN_PUBKEY)" \
				--reset \
				--ledger "$(LOCAL_LEDGER_DIR)" \
				--limit-ledger-size 50000000 \
				> "$(LOCAL_VALIDATOR_LOG)" 2>&1 < /dev/null & \
			disown; \
			echo $$! > "$(LOCAL_VALIDATOR_PID)"; \
			echo "Waiting for validator on $(LOCAL_RPC_URL)..."; \
			for attempt in $$(seq 1 $(LOCAL_VALIDATOR_BOOT_WAIT)); do \
				if solana cluster-version --url "$(LOCAL_RPC_URL)" >/dev/null 2>&1; then \
					break; \
				fi; \
				sleep 1; \
			done; \
			if ! solana cluster-version --url "$(LOCAL_RPC_URL)" >/dev/null 2>&1; then \
				echo "Local validator did not become healthy within $(LOCAL_VALIDATOR_BOOT_WAIT)s"; \
				exit 1; \
			fi; \
		fi; \
	else \
		echo "Starting local validator..."; \
		nohup solana-test-validator \
			--bind-address 127.0.0.1 \
			--faucet-port 0 \
			--mint "$(ADMIN_PUBKEY)" \
			--reset \
			--ledger "$(LOCAL_LEDGER_DIR)" \
			--limit-ledger-size 50000000 \
			> "$(LOCAL_VALIDATOR_LOG)" 2>&1 < /dev/null & \
		disown; \
		echo $$! > "$(LOCAL_VALIDATOR_PID)"; \
		echo "Waiting for validator on $(LOCAL_RPC_URL)..."; \
		for attempt in $$(seq 1 $(LOCAL_VALIDATOR_BOOT_WAIT)); do \
			if solana cluster-version --url "$(LOCAL_RPC_URL)" >/dev/null 2>&1; then \
				break; \
			fi; \
			sleep 1; \
		done; \
		if ! solana cluster-version --url "$(LOCAL_RPC_URL)" >/dev/null 2>&1; then \
			echo "Local validator did not become healthy within $(LOCAL_VALIDATOR_BOOT_WAIT)s"; \
			exit 1; \
		fi; \
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
	@echo "Building program and refreshing IDL..."
	@$(MAKE) build
	@echo "Deploying to local validator..."
	anchor deploy --provider.cluster localnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

# Local TS setup is intentionally opt-in until that surface is refreshed.
local-setup: wallets
	@echo "Running local setup script against $(LOCAL_RPC_URL)..."
	@echo "Note: scripts/setup-local.ts is currently stale relative to the latest market close-time rules."
	$(LOCAL_TS_ENV) $(TSX) scripts/setup-local.ts $(WALLET)

local-bots: wallets
	@mkdir -p $(LOCAL_STATE_DIR)
	@echo "Seeding local order books..."
	$(LOCAL_TS_ENV) $(TSX) scripts/seed-bots.ts

local-ui-ready: local local-setup local-bots
	@echo ""
	@echo "Local UI environment is ready."
	@echo "Start the frontend with:"
	@echo "  cd frontend && npm run dev"

local-ui:
	cd frontend && npm run dev

local-live: wallets
	@echo "Starting local live bot..."
	$(LOCAL_TS_ENV) $(TSX) scripts/live-bots.ts

local-strategy: wallets
	@echo "Starting local strategy bots..."
	$(LOCAL_TS_ENV) $(TSX) scripts/strategy-bots.ts

local-test-rust:
	cargo test -p meridian

local-test-anchor: wallets
	anchor test --skip-build

local-test-smoke: local-deploy
	@echo "Running targeted validator-backed roundtrip smoke test..."
	$(LOCAL_TEST_ENV) npm test -- --grep "$(SMOKE_TEST_GREP)"

local-test-grep:
	@if [ -z "$(GREP)" ]; then \
		echo "Usage: make local-test-grep GREP='your test regex'"; \
		exit 1; \
	fi
	@echo "Running focused validator-backed tests matching: $(GREP)"
	$(LOCAL_TEST_ENV) npm test -- --grep "$(GREP)"

local-check: local-test-rust
	@echo ""
	@echo "Local Rust checks passed"

devnet-env-check:
	$(call require_any_var,DEVNET_RPC_URL,DEVNET_URL)
	$(call require_var,DEVNET_USDC_MINT)
	@echo "Devnet config"
	@echo "  RPC: $(DEVNET_URL)"
	@echo "  USDC mint: $(DEVNET_USDC_MINT)"

railway-env-check:
	$(call require_any_var,DEVNET_RPC_URL,DEVNET_URL)
	$(call require_var,DEVNET_USDC_MINT)
	$(call require_var,RAILWAY_FRONTEND_SERVICE)
	$(call require_var,RAILWAY_BOTS_SERVICE)
	@echo "Railway config"
	@echo "  Frontend+API service: $(RAILWAY_FRONTEND_SERVICE)"
	@echo "  Bots service: $(RAILWAY_BOTS_SERVICE)"
	@echo "  RPC: $(DEVNET_URL)"
	@echo "  USDC mint: $(DEVNET_USDC_MINT)"

railway-sync: railway-env-check
	@printf '%s\n' \
		"ANCHOR_PROVIDER_URL=$(DEVNET_URL)" \
		"RPC_URL=$(DEVNET_URL)" \
		"USDC_MINT=$(DEVNET_USDC_MINT)" \
		"VITE_RPC_URL=$(DEVNET_URL)" \
		"VITE_USDC_MINT=$(DEVNET_USDC_MINT)" \
		"VITE_DEV_WALLET=$(VITE_DEV_WALLET)" \
		"VITE_SIGNAL_URL=$(RAILWAY_BOTS_URL)" \
		"RAILWAY_DOCKERFILE_PATH=frontend.Dockerfile" \
	| xargs railway variable set -s "$(RAILWAY_FRONTEND_SERVICE)"
	@printf '%s\n' \
		"ANCHOR_PROVIDER_URL=$(DEVNET_URL)" \
		"RPC_URL=$(DEVNET_URL)" \
		"USDC_MINT=$(DEVNET_USDC_MINT)" \
		"DEMO_TICKER=$(DEMO_TICKER)" \
		"RAILWAY_DOCKERFILE_PATH=automation/Dockerfile" \
	| xargs railway variable set -s "$(RAILWAY_BOTS_SERVICE)"

railway-deploy-frontend: railway-env-check
	RAILWAY_DOCKERFILE_PATH=frontend.Dockerfile railway up -s "$(RAILWAY_FRONTEND_SERVICE)" -d

railway-deploy-bots: railway-env-check
	railway up -s "$(RAILWAY_BOTS_SERVICE)" -d

railway-deploy: railway-env-check railway-deploy-frontend railway-deploy-bots

railway-release: railway-sync railway-deploy

devnet-deploy: wallets devnet-env-check
	@echo "Admin pubkey: $(ADMIN_PUBKEY)"
	@$(MAKE) build
	anchor deploy --provider.cluster devnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

# Devnet should be static. Reuse the configured mint instead of silently creating
# a new one each run.
devnet-setup: wallets devnet-env-check
	@echo "Setting up devnet markets with static USDC mint $(DEVNET_USDC_MINT)..."
	$(DEVNET_TS_ENV) $(TSX) scripts/setup-devnet.ts

devnet-health: wallets devnet-env-check
	$(DEVNET_READONLY_ENV) $(TSX) scripts/health-check.ts

devnet-settle: wallets devnet-env-check
	@echo "Running settlement job against devnet..."
	cd automation && $(DEVNET_AUTOMATION_ENV) $(TSX) src/index.ts --settle

devnet-morning: wallets devnet-env-check
	@echo "Running morning job against devnet..."
	cd automation && $(DEVNET_AUTOMATION_ENV) $(TSX) src/index.ts --now

devnet-reset: wallets devnet-env-check devnet-settle devnet-morning
	@echo "Seeding devnet order books..."
	$(DEVNET_TS_ENV) $(TSX) scripts/seed-bots.ts

wallet-pubkeys: wallets
	@echo "Admin: $$(solana-keygen pubkey $(ADMIN_WALLET))"
	@echo "Bot-A: $$(solana-keygen pubkey $(BOT_A_WALLET))"
	@echo "Bot-B: $$(solana-keygen pubkey $(BOT_B_WALLET))"

clean: local-validator-stop
	@for script in seed-bots.ts live-bots.ts strategy-bots.ts; do \
		pkill -f "/$$script" 2>/dev/null || true; \
	done
	@echo "Stopped tracked local validator and local bot processes"

# --- ALPHA mode (rapid short-cycle UAT) ---
# Creates fresh markets with short close times, settles + closes them, repeat.
# ALPHA_CYCLE_MINUTES controls market lifetime (default: 12).
# admin_settle_delay in GlobalConfig must be short for fast cycles (default is 1hr).

ALPHA_TS_ENV = ALPHA=1 $(LOCAL_TS_ENV)
DEVNET_ALPHA_TS_ENV = ALPHA=1 $(DEVNET_TS_ENV)

alpha-cycle: wallets
	@echo "=== ALPHA Cycle: creating fresh short-lived markets ==="
	$(ALPHA_TS_ENV) $(TSX) scripts/alpha-cycle.ts

alpha-settle: wallets
	@echo "=== ALPHA Settle: settling + closing all markets ==="
	$(ALPHA_TS_ENV) $(TSX) scripts/alpha-settle.ts

alpha-seed: wallets
	@echo "=== ALPHA Seed: seeding order books ==="
	$(ALPHA_TS_ENV) $(TSX) scripts/seed-bots.ts

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

alpha-nuke: wallets
	@echo "=== ALPHA Nuke: settle all + close all + redeploy program ==="
	$(LOCAL_TS_ENV) $(TSX) scripts/smart-deploy.ts

alpha-full-reset: wallets local-validator-reset local-deploy local-setup local-bots
	@echo "=== ALPHA Full Reset Complete ==="
