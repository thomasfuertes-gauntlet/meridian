.PHONY: \
	build clean \
	_wallets _local-validator _local-validator-stop _devnet-env _railway-env \
	local local-deploy local-cycle local-settle local-seed local-smart-deploy \
	local-live local-strategy local-ui local-validator-reset \
	test uat \
	devnet-deploy devnet-setup devnet-health devnet-settle devnet-morning \
	devnet-reset devnet-bootstrap nuke \
	railway-sync railway-deploy

# ── Config & Variables ──────────────────────────────────────────

export PATH := $(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.cargo/bin:$(PATH)

-include .env

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
DEVNET_AUTOMATION_ENV = RPC_URL="$(DEVNET_URL)" USDC_MINT="$(DEVNET_USDC_MINT)" ADMIN_KEYPAIR_PATH=$(ADMIN_WALLET)
SMOKE_TEST_GREP = roundtrips create -> freeze -> settle-with-proof -> redeem against config-backed oracle policy

define require_var
	@if [ -z "$($1)" ]; then \
		echo "Missing required config: $1"; \
		echo "Set it in .env, export it in your shell, or pass it inline."; \
		if [ -f .env.example ]; then \
			echo "Start from: cp .env.example .env"; \
		fi; \
		exit 1; \
	fi
endef

define require_any_var
	@if [ -z "$($1)" ] && [ -z "$($2)" ]; then \
		echo "Missing required config: $1 or $2"; \
		echo "Set one of them in .env, export it in your shell, or pass it inline."; \
		if [ -f .env.example ]; then \
			echo "Start from: cp .env.example .env"; \
		fi; \
		exit 1; \
	fi
endef

# ── Internal ────────────────────────────────────────────────────

_wallets:
	@$(TSX) scripts/dev-wallets.ts

_local-validator:
	@mkdir -p $(LOCAL_STATE_DIR)
	@# Kill stale validator if tracked but unhealthy
	@if [ -f "$(LOCAL_VALIDATOR_PID)" ]; then \
		if kill -0 "$$(cat $(LOCAL_VALIDATOR_PID))" 2>/dev/null && \
		   solana cluster-version --url "$(LOCAL_RPC_URL)" >/dev/null 2>&1; then \
			echo "Local validator already running (pid $$(cat $(LOCAL_VALIDATOR_PID)))"; \
			exit 0; \
		fi; \
		kill "$$(cat $(LOCAL_VALIDATOR_PID))" 2>/dev/null || true; \
		rm -f "$(LOCAL_VALIDATOR_PID)"; \
	fi
	@echo "Starting local validator..."
	@nohup solana-test-validator \
		--bind-address 127.0.0.1 \
		--faucet-port 0 \
		--mint "$(ADMIN_PUBKEY)" \
		--reset \
		--ledger "$(LOCAL_LEDGER_DIR)" \
		--limit-ledger-size 50000000 \
		> "$(LOCAL_VALIDATOR_LOG)" 2>&1 < /dev/null & \
	disown; \
	echo $$! > "$(LOCAL_VALIDATOR_PID)"
	@echo "Waiting for validator on $(LOCAL_RPC_URL)..."
	@for attempt in $$(seq 1 $(LOCAL_VALIDATOR_BOOT_WAIT)); do \
		if solana cluster-version --url "$(LOCAL_RPC_URL)" >/dev/null 2>&1; then \
			break; \
		fi; \
		sleep 1; \
	done; \
	if ! solana cluster-version --url "$(LOCAL_RPC_URL)" >/dev/null 2>&1; then \
		echo "Local validator did not become healthy within $(LOCAL_VALIDATOR_BOOT_WAIT)s"; \
		exit 1; \
	fi

_local-validator-stop:
	@if [ -f "$(LOCAL_VALIDATOR_PID)" ] && kill -0 "$$(cat $(LOCAL_VALIDATOR_PID))" 2>/dev/null; then \
		echo "Stopping local validator (pid $$(cat $(LOCAL_VALIDATOR_PID)))"; \
		kill "$$(cat $(LOCAL_VALIDATOR_PID))"; \
		rm -f "$(LOCAL_VALIDATOR_PID)"; \
	else \
		echo "No tracked local validator is running"; \
	fi

_devnet-env:
	$(call require_any_var,DEVNET_RPC_URL,DEVNET_URL)
	$(call require_var,DEVNET_USDC_MINT)
	@echo "Devnet config"
	@echo "  RPC: $(DEVNET_URL)"
	@echo "  USDC mint: $(DEVNET_USDC_MINT)"

_railway-env:
	$(call require_any_var,DEVNET_RPC_URL,DEVNET_URL)
	$(call require_var,DEVNET_USDC_MINT)
	$(call require_var,RAILWAY_SERVICE)

# ── Local Development ──────────────────────────────────────────
# `make local` is the single entry point: validator -> deploy -> markets -> seed.
# Markets expire in 12 minutes (CYCLE_MINUTES). Run `make local-settle` to settle,
# or `make local-cycle` to rotate to fresh markets.

local: local-deploy local-cycle local-seed  ## Full local: deploy + 12-min markets + seeded books

local-deploy: _wallets _local-validator
	@mkdir -p $(LOCAL_STATE_DIR)
	@echo "Building program and refreshing IDL..."
	@$(MAKE) build
	@echo "Deploying to local validator..."
	anchor deploy --provider.cluster localnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

local-cycle: _wallets  ## Create fresh 12-min markets (settle old first)
	$(LOCAL_TS_ENV) $(TSX) scripts/cycle.ts

local-settle: _wallets  ## Settle + close all markets
	$(LOCAL_TS_ENV) $(TSX) scripts/settle-cycle.ts

local-seed: _wallets  ## Seed order books with bot liquidity
	$(LOCAL_TS_ENV) $(TSX) scripts/seed-bots.ts

local-smart-deploy: _wallets  ## Hash-compare redeploy (settle/close first if needed)
	$(LOCAL_TS_ENV) $(TSX) scripts/smart-deploy.ts

local-live: _wallets
	$(LOCAL_TS_ENV) $(TSX) scripts/live-bots.ts

local-strategy: _wallets
	$(LOCAL_TS_ENV) $(TSX) scripts/strategy-bots.ts

local-ui:
	cd frontend && npm run dev

local-validator-reset: _local-validator-stop
	@rm -rf $(LOCAL_STATE_DIR)

# ── Tests ──────────────────────────────────────────────────────

test: _wallets
	@if [ -n "$(GREP)" ]; then \
		$(LOCAL_TEST_ENV) npm test -- --grep "$(GREP)"; \
	else \
		anchor test --skip-build; \
	fi

uat: _wallets  ## E2E lifecycle test: create -> mint -> trade -> settle -> redeem
	$(LOCAL_TS_ENV) CYCLE_MINUTES=2 $(TSX) scripts/uat.ts

# ── Devnet ─────────────────────────────────────────────────────

devnet-deploy: _wallets _devnet-env
	@$(MAKE) build
	anchor deploy --provider.cluster devnet --provider.wallet "$(ADMIN_WALLET)" --no-idl

devnet-setup: _wallets _devnet-env
	$(DEVNET_TS_ENV) $(TSX) scripts/setup-devnet.ts

devnet-health: _wallets _devnet-env
	$(DEVNET_READONLY_ENV) $(TSX) scripts/health-check.ts

devnet-settle: _wallets _devnet-env
	$(DEVNET_AUTOMATION_ENV) $(TSX) scripts/automation.ts --settle

devnet-morning: _wallets _devnet-env
	$(DEVNET_AUTOMATION_ENV) $(TSX) scripts/automation.ts --now

devnet-reset: _wallets _devnet-env devnet-settle devnet-morning
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

nuke: _wallets _devnet-env  ## Devnet: settle all, close all, drain SOL to admin (y/N prompt)
	$(DEVNET_TS_ENV) $(TSX) scripts/nuke-devnet.ts $(NUKE_FLAGS)

# ── Railway ────────────────────────────────────────────────────

railway-sync: _railway-env
	@printf '%s\n' \
		"ANCHOR_PROVIDER_URL=$(DEVNET_URL)" \
		"USDC_MINT=$(DEVNET_USDC_MINT)" \
		"VITE_RPC_URL=$(DEVNET_URL)" \
		"VITE_USDC_MINT=$(DEVNET_USDC_MINT)" \
		"VITE_DEV_WALLET=$(VITE_DEV_WALLET)" \
		"RAILWAY_DOCKERFILE_PATH=Dockerfile" \
		"DEMO_TICKER=$(DEMO_TICKER)" \
	| xargs railway variable set -s "$(RAILWAY_SERVICE)"

railway-deploy: _railway-env
	railway up -s "$(RAILWAY_SERVICE)" -d

# ── Build & Cleanup ────────────────────────────────────────────

build:
	anchor build
	@cp target/idl/meridian.json $(APP_IDL_PATH)

clean: _local-validator-stop
	@for script in seed-bots.ts live-bots.ts strategy-bots.ts; do \
		pkill -f "/$$script" 2>/dev/null || true; \
	done
	@echo "Stopped local validator and bot processes"
