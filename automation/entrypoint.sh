#!/usr/bin/env bash
set -euo pipefail

# Railway bot runner entrypoint.
# Deterministic wallets are pre-generated in Dockerfile (dev-wallets.ts).
# USDC_MINT and ANCHOR_PROVIDER_URL must be set as Railway env vars.

export ANCHOR_WALLET=".wallets/admin.json"
export DEMO_TICKER="${DEMO_TICKER:-NVDA}"

if [ -z "${USDC_MINT:-}" ]; then
  echo "ERROR: USDC_MINT env var not set. Run setup-devnet.ts first."
  exit 1
fi

if [ -z "${ANCHOR_PROVIDER_URL:-}" ]; then
  echo "ERROR: ANCHOR_PROVIDER_URL env var not set."
  exit 1
fi

echo "Meridian Bot Runner"
echo "  RPC: $ANCHOR_PROVIDER_URL"
echo "  USDC: $USDC_MINT"
echo "  Demo ticker: $DEMO_TICKER"
echo "  Wallet: $(npx tsx -e "const {getDevWallet}=require('./scripts/dev-wallets');console.log(getDevWallet('bot-a').publicKey.toString())" 2>/dev/null || echo 'bot-a')"

echo "Running seed-bots (auto-skips if already seeded)..."
npx tsx scripts/seed-bots.ts

echo "Starting live trading bot..."
npx tsx scripts/live-bots.ts &
LIVE_PID=$!

echo "Waiting 30s for order book liquidity..."
sleep 30

echo "Starting strategy bots..."
npx tsx scripts/strategy-bots.ts &
STRAT_PID=$!

# Exit container if either bot dies (Railway will restart)
wait -n $LIVE_PID $STRAT_PID
echo "FATAL: a bot process died, exiting for container restart"
exit 1
