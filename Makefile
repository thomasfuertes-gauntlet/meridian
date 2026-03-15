.PHONY: \
	build clean \
	_wallets _mock-pyth _local-validator _local-validator-stop _devnet-env _railway-env _local-deploy \
	local local-cycle local-settle local-seed \
	local-live local-strategy local-ui local-validator-reset \
	test uat \
	devnet-deploy devnet-setup devnet-fund-bots devnet-health \
	nuke \
	railway-deploy railway-env

# ── Config & Variables ──────────────────────────────────────────

export PATH := $(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.cargo/bin:$(PATH)

-include .env

ADMIN_WALLET ?= .wallets/admin.json
PROGRAM_KEYPAIR ?= target/deploy/meridian-keypair.json
LOCAL_STATE_DIR ?= .localnet
LOCAL_RPC_URL ?= http://127.0.0.1:8899
LOCAL_VALIDATOR_PID ?= $(LOCAL_STATE_DIR)/validator.pid
LOCAL_VALIDATOR_BOOT_WAIT ?= 30
# KEY-DECISION 2026-03-13: use 'node --import tsx' not the 'tsx' CLI.
# The tsx CLI opens an IPC pipe that hits EPERM in sandboxed/non-interactive shells.
TSX ?= node --import tsx

DEVNET_URL ?= $(or $(DEVNET_RPC_URL),https://api.devnet.solana.com)
RAILWAY_SERVICE ?= meridian
VITE_DEV_WALLET ?= true
DEMO_TICKER ?= NVDA
ENABLE_LIQUIDITY_BOT ?= false
ENABLE_TRADE_BOTS ?= false

ADMIN_PUBKEY = $$(solana-keygen pubkey $(ADMIN_WALLET))
LOCAL_TS_ENV = ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" DEMO_TICKER="$(DEMO_TICKER)"
DEVNET_READONLY_ENV = ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)"
DEVNET_TS_ENV = ANCHOR_PROVIDER_URL="$(DEVNET_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" USDC_MINT="$(DEVNET_USDC_MINT)"

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

MOCK_PYTH_SO = mock-pyth/target/deploy/mock_pyth.so

_wallets:
	@$(TSX) scripts/dev-wallets.ts

$(MOCK_PYTH_SO): mock-pyth/src/lib.rs mock-pyth/Cargo.toml
	cd mock-pyth && cargo build-sbf

_mock-pyth: $(MOCK_PYTH_SO)

_local-validator: _mock-pyth
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
		--bpf-program rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ $(MOCK_PYTH_SO) \
		--reset \
		--ledger "$(LOCAL_STATE_DIR)/ledger" \
		--limit-ledger-size 50000000 \
		> "$(LOCAL_STATE_DIR)/validator.log" 2>&1 < /dev/null & \
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

local: _local-deploy local-cycle local-seed  ## Full local: deploy + 12-min markets + seeded books

_local-deploy: _wallets _local-validator
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

local-live: _wallets
	$(LOCAL_TS_ENV) $(TSX) scripts/live-bots.ts

local-strategy: _wallets
	$(LOCAL_TS_ENV) $(TSX) scripts/strategy-bots.ts

local-ui:
	cd frontend && npm run dev

local-validator-reset: _local-validator-stop
	@rm -rf $(LOCAL_STATE_DIR)

# ── Tests ──────────────────────────────────────────────────────

test: _wallets _mock-pyth
	@if [ -n "$(GREP)" ]; then \
		ANCHOR_PROVIDER_URL="$(LOCAL_RPC_URL)" ANCHOR_WALLET="$(ADMIN_WALLET)" npm test -- --grep "$(GREP)"; \
	else \
		anchor test --skip-build; \
	fi

uat: _wallets  ## E2E lifecycle test: create -> mint -> trade -> settle -> redeem
	$(LOCAL_TS_ENV) CYCLE_MINUTES=2 $(TSX) scripts/uat.ts

# ── Devnet ─────────────────────────────────────────────────────

devnet-deploy: _wallets _devnet-env
	@$(MAKE) build
	anchor deploy --provider.cluster "$(DEVNET_URL)" --provider.wallet "$(ADMIN_WALLET)" --no-idl

devnet-setup: _wallets _devnet-env  ## USDC mint + GlobalConfig (no bots)
	$(DEVNET_TS_ENV) $(TSX) scripts/setup-devnet.ts

devnet-fund-bots: _wallets _devnet-env  ## Fund bot-a/bot-b with SOL + USDC
	$(DEVNET_TS_ENV) $(TSX) scripts/fund-bots.ts

devnet-health: _wallets _devnet-env
	$(DEVNET_READONLY_ENV) $(TSX) scripts/health-check.ts

nuke: _wallets _devnet-env  ## Devnet: settle all, close all, drain SOL to admin (y/N prompt)
	$(DEVNET_TS_ENV) $(TSX) scripts/nuke-devnet.ts $(NUKE_FLAGS)

# ── Railway ────────────────────────────────────────────────────

railway-deploy:  ## Push container to Railway
	$(call require_var,RAILWAY_SERVICE)
	railway up -s "$(RAILWAY_SERVICE)" -d

railway-env: _railway-env  ## Sync env vars to Railway service
	@printf '%s\n' \
		"ANCHOR_PROVIDER_URL=$(DEVNET_URL)" \
		"USDC_MINT=$(DEVNET_USDC_MINT)" \
		"VITE_RPC_URL=$(DEVNET_URL)" \
		"VITE_USDC_MINT=$(DEVNET_USDC_MINT)" \
		"VITE_DEV_WALLET=$(VITE_DEV_WALLET)" \
		"RAILWAY_DOCKERFILE_PATH=Dockerfile" \
		"DEMO_TICKER=$(DEMO_TICKER)" \
		"ENABLE_LIQUIDITY_BOT=$(ENABLE_LIQUIDITY_BOT)" \
		"ENABLE_TRADE_BOTS=$(ENABLE_TRADE_BOTS)" \
	| xargs railway variable set -s "$(RAILWAY_SERVICE)"

# ── Build & Cleanup ────────────────────────────────────────────

build:
	anchor build
	@cp target/idl/meridian.json frontend/src/idl/meridian.json

clean: _local-validator-stop
	@for script in seed-bots.ts live-bots.ts strategy-bots.ts; do \
		pkill -f "/$$script" 2>/dev/null || true; \
	done
	@echo "Stopped local validator and bot processes"
