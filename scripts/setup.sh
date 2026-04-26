#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "[setup] Installing Worker dependencies..."
(cd worker && npm install)

echo "[setup] Installing dashboard dependencies..."
(cd dashboard && npm install)

if [ ! -d "$ROOT_DIR/.venv" ]; then
  echo "[setup] Creating Python virtual environment..."
  python3 -m venv "$ROOT_DIR/.venv"
fi

echo "[setup] Installing Python dependencies..."
"$ROOT_DIR/.venv/bin/pip" install -r requirements.txt

if [ ! -f "$ROOT_DIR/.env" ]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  echo "[setup] Created .env from .env.example"
fi

if [ ! -f "$ROOT_DIR/worker/.dev.vars" ]; then
  cp "$ROOT_DIR/worker/.dev.vars.example" "$ROOT_DIR/worker/.dev.vars"
  echo "[setup] Created worker/.dev.vars from worker/.dev.vars.example"
fi

if [ ! -f "$ROOT_DIR/dashboard/.env" ]; then
  cp "$ROOT_DIR/dashboard/.env.example" "$ROOT_DIR/dashboard/.env"
  echo "[setup] Created dashboard/.env from dashboard/.env.example"
fi

echo "[setup] Done."
echo "[setup] Fill in real DISTIL_* values before running the live diagnosis flow."
