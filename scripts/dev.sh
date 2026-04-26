#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_URL="${WORKER_URL:-http://localhost:8788}"

cleanup() {
  if [ -n "${WORKER_PID:-}" ]; then
    kill "$WORKER_PID" 2>/dev/null || true
  fi
  if [ -n "${DASHBOARD_PID:-}" ]; then
    kill "$DASHBOARD_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[dev] Starting Worker at $WORKER_URL..."
(
  cd "$ROOT_DIR/worker"
  npm run dev
) &
WORKER_PID=$!

echo "[dev] Starting dashboard..."
(
  cd "$ROOT_DIR/dashboard"
  VITE_WORKER_URL="$WORKER_URL" npm run dev -- --host 0.0.0.0
) &
DASHBOARD_PID=$!

echo "[dev] Worker PID: $WORKER_PID"
echo "[dev] Dashboard PID: $DASHBOARD_PID"
echo "[dev] Press Ctrl+C to stop both."

wait
