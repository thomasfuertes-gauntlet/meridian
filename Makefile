.PHONY: \
	build wallets bootstrap-fresh wallet-pubkeys clean \
	local local-validator local-validator-stop local-validator-reset local-validator-live \
	local-deploy local-cycle local-settle local-seed local-smart-deploy \
	local-live local-strategy local-ui \
	local-test-rust local-test-anchor local-test-smoke local-test-grep \
	devnet-env-check devnet-deploy devnet-setup devnet-health devnet-settle devnet-morning \
	devnet-reset devnet-bootstrap nuke \
	railway-env-check railway-sync railway-deploy \
	uat

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
LOCAL_VALIDATOR_BOOT_WAIT ?= 30
# KEY-DECISION 2026-03-13: use 'node --import tsx' not the 'tsx' CLI.
# The tsx CLI opens an IPC pipe that hits EPERM in sandboxed/non-interactive shells.
TSX ?= node --import tsx

DEVNET_URL ?= $(or $(DEVNET_RPC_URL),https://api.devnet.solana.com)
RAILWAY_SERVICE ?= meridian
VITE_DEV_WALLET ?= true
DEMO_TICKER ?= NVDA

ADMIN_PUBKEY = $$(solana-keygen pubkey $(ADMIN_WALLET))
LOCAL_TS_ENV = ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" OFFLINE="$(OFFLINE)" DEMO_TICKER="$(DEMO_TICKER)"
LOCAL_TEST_ENV = ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)"
DEVNET_READONLY_ENV = ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)"
DEVNET_TS_ENV = ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" USDC_MINT="$(DEVNET_USDC_MINT)"
DEVNET_BOOTSTRAP_ENV = ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" OFFLINE=1
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

# ── Build + Setup ────────────────────────────────────────────────

build:
	anchor build
	@cp target/idl/meridian.json $(APP_IDL_PATH)

wallets:
	@$(TSX) scripts/dev-wallets.ts

bootstrap-fresh:
	@echo "=== Meridian Fresh Bootstrap ==="
	@echo "Generating fresh keypairs..."
	WALLET_MODE=generate $(TSX) scripts/dev-wallets.ts
	@echo "Patching program ID..."
	$(TSX) scripts/patch-program-id.ts
	@$(MAKE) build
	@$(MAKE) local-validator
	anchor deploy --provider.cluster localnet --provider.wallet "$(ADMIN_WALLET)" --no-idl
	@echo "Creating markets (12-min cycle)..."
	OFFLINE=1 $(LOCAL_TS_ENV) $(TSX) scripts/cycle.ts
	@echo "Seeding order books..."
	OFFLINE=1 $(LOCAL_TS_ENV) $(TSX) scripts/seed-bots.ts
	@echo ""
	@echo "=== Bootstrap Complete ==="
	@echo "Program ID: $$(solana-keygen pubkey $(PROGRAM_KEYPAIR) 2>/dev/null || echo 'unknown')"
	@echo "Admin: $(ADMIN_PUBKEY)"

wallet-pubkeys: wallets
	@echo "Admin: $$(solana-keygen pubkey $(ADMIN_WALLET))"
	@echo "Bot-A: $$(solana-keygen pubkey $(BOT_A_WALLET))"
	@echo "Bot-B: $$(solana-keygen pubkey $(BOT_B_WALLET))"

# ── Local Development ───────────────────────────────────────────
# `make local` is the single entry point: validator → deploy → markets → seed.
# Markets expire in 12 minutes (CYCLE_MINUTES). Run `make local-settle` to settle,
# or `make local-cycle` to rotate to fresh markets.

local: local-deploy local-cycle local-seed  ## Full local: deploy + 12-min markets + seeded books

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

local-validator-live:
	solana-test-validator --bind-address 127.0.0.1 --mint "$(ADMIN_PUBKEY)" --reset --ledger "$(LOCAL_LEDGER_DIR)" --limit-ledger-size 50000000

local-deploy: wallets local-validator
	@mkdir -p $(LOCAL_STATE_DIR)
	@echo "Building program and refreshing IDL..."
	@$(MAKE) build
	@echo "Deploying to local validator..."
	anchor deploy --provider.cluster localnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

local-cycle: wallets  ## Create fresh 12-min markets (settle old first)
	$(LOCAL_TS_ENV) $(TSX) scripts/cycle.ts

local-settle: wallets  ## Settle + close all markets
	$(LOCAL_TS_ENV) $(TSX) scripts/settle-cycle.ts

local-seed: wallets  ## Seed order books with bot liquidity
	$(LOCAL_TS_ENV) $(TSX) scripts/seed-bots.ts

local-smart-deploy: wallets  ## Hash-compare redeploy (settle/close first if needed)
	$(LOCAL_TS_ENV) $(TSX) scripts/smart-deploy.ts

local-live: wallets
	$(LOCAL_TS_ENV) $(TSX) scripts/live-bots.ts

local-strategy: wallets
	$(LOCAL_TS_ENV) $(TSX) scripts/strategy-bots.ts

local-ui:
	cd frontend && npm run dev

# ── Tests ────────────────────────────────────────────────────────

local-test-rust:
	cargo test -p meridian

local-test-anchor: wallets
	anchor test --skip-build

local-test-smoke: local-deploy
	$(LOCAL_TEST_ENV) npm test -- --grep "$(SMOKE_TEST_GREP)"

local-test-grep:
	@if [ -z "$(GREP)" ]; then echo "Usage: make local-test-grep GREP='pattern'"; exit 1; fi
	$(LOCAL_TEST_ENV) npm test -- --grep "$(GREP)"

uat: wallets  ## E2E lifecycle test: create → mint → trade → settle → redeem
	$(LOCAL_TS_ENV) CYCLE_MINUTES=2 $(TSX) scripts/uat.ts

# ── Devnet ───────────────────────────────────────────────────────

devnet-env-check:
	$(call require_any_var,DEVNET_RPC_URL,DEVNET_URL)
	$(call require_var,DEVNET_USDC_MINT)
	@echo "Devnet config"
	@echo "  RPC: $(DEVNET_URL)"
	@echo "  USDC mint: $(DEVNET_USDC_MINT)"

devnet-deploy: wallets devnet-env-check
	@$(MAKE) build
	anchor deploy --provider.cluster devnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

devnet-setup: wallets devnet-env-check
	$(DEVNET_TS_ENV) $(TSX) scripts/setup-devnet.ts

devnet-health: wallets devnet-env-check
	$(DEVNET_READONLY_ENV) $(TSX) scripts/health-check.ts

devnet-settle: wallets devnet-env-check
	cd automation && $(DEVNET_AUTOMATION_ENV) $(TSX) src/index.ts --settle

devnet-morning: wallets devnet-env-check
	cd automation && $(DEVNET_AUTOMATION_ENV) $(TSX) src/index.ts --now

devnet-reset: wallets devnet-env-check devnet-settle devnet-morning
	$(DEVNET_TS_ENV) $(TSX) scripts/seed-bots.ts

devnet-bootstrap:
	@echo "=== Devnet Bootstrap ==="
	WALLET_MODE=generate $(TSX) scripts/dev-wallets.ts
	$(TSX) scripts/patch-program-id.ts
	@$(MAKE) build
	$(DEVNET_BOOTSTRAP_ENV) $(TSX) scripts/devnet-fund.ts
	anchor deploy --provider.cluster devnet --provider.wallet "$(ADMIN_WALLET)" --no-idl
	$(DEVNET_BOOTSTRAP_ENV) $(TSX) scripts/setup-devnet.ts
	$(DEVNET_BOOTSTRAP_ENV) $(TSX) scripts/seed-bots.ts
	@echo ""
	@echo "=== Devnet Bootstrap Complete ==="
	@echo "Program ID: $$(solana-keygen pubkey $(PROGRAM_KEYPAIR) 2>/dev/null || echo 'unknown')"
	@echo "Admin:      $(ADMIN_PUBKEY)"

nuke: wallets devnet-env-check  ## Devnet: settle all, close all, drain SOL to admin (y/N prompt)
	$(DEVNET_TS_ENV) $(TSX) scripts/nuke-devnet.ts

# ── Railway ──────────────────────────────────────────────────────

railway-env-check:
	$(call require_any_var,DEVNET_RPC_URL,DEVNET_URL)
	$(call require_var,DEVNET_USDC_MINT)
	$(call require_var,RAILWAY_SERVICE)

railway-sync: railway-env-check
	@printf '%s\n' \
		"ANCHOR_PROVIDER_URL=$(DEVNET_URL)" \
		"USDC_MINT=$(DEVNET_USDC_MINT)" \
		"VITE_RPC_URL=$(DEVNET_URL)" \
		"VITE_USDC_MINT=$(DEVNET_USDC_MINT)" \
		"VITE_DEV_WALLET=$(VITE_DEV_WALLET)" \
		"RAILWAY_DOCKERFILE_PATH=Dockerfile" \
		"DEMO_TICKER=$(DEMO_TICKER)" \
	| xargs railway variable set -s "$(RAILWAY_SERVICE)"

railway-deploy: railway-env-check
	railway up -s "$(RAILWAY_SERVICE)" -d

# ── Cleanup ──────────────────────────────────────────────────────

clean: local-validator-stop
	@for script in seed-bots.ts live-bots.ts strategy-bots.ts; do \
		pkill -f "/$$script" 2>/dev/null || true; \
	done
	@echo "Stopped local validator and bot processes"
