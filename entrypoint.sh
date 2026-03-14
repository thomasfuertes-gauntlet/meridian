#!/usr/bin/env bash
set -euo pipefail

# Unified Railway entrypoint: SPA + bots + automation in one container.
# signal-server serves both the frontend SPA and the active-market signal endpoint.
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

echo "Meridian (unified container)"
echo "  RPC: $ANCHOR_PROVIDER_URL"
echo "  USDC: $USDC_MINT"
echo "  Demo ticker: $DEMO_TICKER"
echo "  bot-a: 48xYES8qxE1vvHPVJKJCdKRhDMbueeWmJhGHKQ3gWGhh"
echo "  bot-b: RSG4qia3Dp9pGPzsMnFS9AzsRPKyJxJ75iyoSubwQ5W"

echo "Starting automation cron (morning 8AM ET + settlement 5:05PM ET)..."
npx tsx automation/src/index.ts &
AUTOMATION_PID=$!

echo "Starting signal-server + SPA on :${PORT:-8080}..."
npx tsx scripts/signal-server.ts &
SIGNAL_PID=$!

echo "Running seed-bots (auto-skips if already seeded)..."
npx tsx scripts/seed-bots.ts

echo "Starting live trading bot..."
npx tsx scripts/live-bots.ts &
LIVE_PID=$!

echo "Waiting 90s for order book liquidity + RPC cooldown..."
sleep 90

echo "Starting strategy bots..."
npx tsx scripts/strategy-bots.ts &
STRAT_PID=$!

# Exit container if any process dies (Railway will restart)
wait -n $AUTOMATION_PID $SIGNAL_PID $LIVE_PID $STRAT_PID
echo "FATAL: a process died, exiting for container restart"
exit 1
