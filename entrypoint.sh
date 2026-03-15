#!/usr/bin/env bash
set -euo pipefail

# Unified Railway entrypoint: SPA + bots + automation in one container.
# signal-server serves both the frontend SPA and the active-market signal endpoint.
# Deterministic wallets are pre-generated in Dockerfile (dev-wallets.ts).
# USDC_MINT and ANCHOR_PROVIDER_URL must be set as Railway env vars.
#
# RPC_URL is derived from ANCHOR_PROVIDER_URL so automation scripts don't need a
# separate Railway variable.
#
# Feature flags (set to "false" to disable; any other value or unset = enabled):
#   ENABLE_AUTOMATION    - automation cron (market setup + settlement)
#   ENABLE_LIQUIDITY_BOT - live-bots market maker
#   ENABLE_TRADE_BOTS    - strategy-bots directional traders
#   ENABLE_FRONTEND      - signal-server + SPA

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

# Automation scripts (morning-job.ts, settlement-job.ts) read RPC_URL.
# Derive it from ANCHOR_PROVIDER_URL so Railway only needs one variable.
export RPC_URL="${RPC_URL:-$ANCHOR_PROVIDER_URL}"

echo "Meridian (unified container)"
echo "  RPC: $ANCHOR_PROVIDER_URL"
echo "  USDC: $USDC_MINT"
echo "  Demo ticker: $DEMO_TICKER"
echo "  bot-a: 48xYES8qxE1vvHPVJKJCdKRhDMbueeWmJhGHKQ3gWGhh"
echo "  bot-b: RSG4qia3Dp9pGPzsMnFS9AzsRPKyJxJ75iyoSubwQ5W"
echo "  ENABLE_AUTOMATION=${ENABLE_AUTOMATION:-true}"
echo "  ENABLE_LIQUIDITY_BOT=${ENABLE_LIQUIDITY_BOT:-true}"
echo "  ENABLE_TRADE_BOTS=${ENABLE_TRADE_BOTS:-true}"
echo "  ENABLE_FRONTEND=${ENABLE_FRONTEND:-true}"

PIDS=()

if [[ "${ENABLE_AUTOMATION:-true}" != "false" ]]; then
  echo "Starting automation cron (morning 8AM ET + settlement 4:07PM ET)..."
  npx tsx scripts/automation.ts &
  PIDS+=($!)
else
  echo "Skipping automation cron (ENABLE_AUTOMATION=false)"
fi

if [[ "${ENABLE_FRONTEND:-true}" != "false" ]]; then
  echo "Starting signal-server + SPA on :${PORT:-8080}..."
  npx tsx scripts/signal-server.ts &
  PIDS+=($!)
else
  echo "Skipping signal-server (ENABLE_FRONTEND=false)"
fi

if [[ "${ENABLE_LIQUIDITY_BOT:-true}" != "false" ]]; then
  # Bootstrap: if no active markets exist and it's a weekday during market hours,
  # run the morning job inline so bots don't crash-loop waiting for the 8 AM cron.
  MARKET_COUNT=$(npx tsx -e "
    import * as anchor from '@coral-xyz/anchor';
    anchor.setProvider(anchor.AnchorProvider.env());
    const p = anchor.workspace.Meridian;
    const all = await (p.account as any).strikeMarket.all();
    const active = all.filter((m: any) => m.account.outcome?.pending !== undefined);
    console.log(active.length);
  " 2>&1 | tail -1) || MARKET_COUNT="unknown"
  if [[ "$MARKET_COUNT" == "0" ]]; then
    echo "No active markets found. Running morning job bootstrap..."
    npx tsx scripts/automation.ts --now || echo "  (bootstrap failed, continuing - cron will retry)"
  else
    echo "  Active markets: $MARKET_COUNT"
  fi

  echo "Starting seed-bots (long-running, re-seeds every 15 min during market hours)..."
  npx tsx scripts/seed-bots.ts &
  PIDS+=($!)

  echo "Starting live trading bot..."
  npx tsx scripts/live-bots.ts &
  PIDS+=($!)
else
  echo "Skipping live-bots (ENABLE_LIQUIDITY_BOT=false)"
fi

if [[ "${ENABLE_TRADE_BOTS:-true}" != "false" ]]; then
  echo "Waiting 90s for order book liquidity + RPC cooldown..."
  sleep 90

  echo "Starting strategy bots..."
  npx tsx scripts/strategy-bots.ts &
  PIDS+=($!)
else
  echo "Skipping strategy-bots (ENABLE_TRADE_BOTS=false)"
fi

if [[ ${#PIDS[@]} -eq 0 ]]; then
  echo "ERROR: all processes disabled via feature flags; nothing to run"
  exit 1
fi

# Exit container if any process dies (Railway will restart)
wait -n "${PIDS[@]}"
echo "FATAL: a process died, exiting for container restart"
exit 1
