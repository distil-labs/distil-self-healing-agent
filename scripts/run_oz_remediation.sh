#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPT_FILE="$ROOT_DIR/oz/remediation_prompt.md"
WORKER_URL="${WORKER_URL:-http://localhost:8788}"
MODE="local"
EXTRA_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cloud)
      MODE="cloud"
      shift
      ;;
    --share)
      EXTRA_ARGS+=("--share")
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  scripts/run_oz_remediation.sh [--cloud] [--share]

Environment:
  WORKER_URL          Worker base URL. Defaults to http://localhost:8788.
  WARP_API_KEY        Required by Oz for headless/non-interactive auth.
  OZ_ENVIRONMENT_ID   Required for --cloud.

Modes:
  local   Runs `oz agent run` in this repository.
  cloud   Runs `oz agent run-cloud` in the configured Oz environment.
EOF
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if ! command -v oz >/dev/null 2>&1; then
  echo "oz CLI not found. Install it from Warp or add it to PATH." >&2
  exit 1
fi

export WORKER_URL

if [ "$MODE" = "cloud" ]; then
  if [ -z "${OZ_ENVIRONMENT_ID:-}" ]; then
    echo "OZ_ENVIRONMENT_ID is required for --cloud." >&2
    exit 1
  fi

  oz agent run-cloud \
    --environment "$OZ_ENVIRONMENT_ID" \
    --name "self-healing-remediation" \
    --prompt "$(cat "$PROMPT_FILE")" \
    "${EXTRA_ARGS[@]}"
else
  oz agent run \
    --cwd "$ROOT_DIR" \
    --name "self-healing-remediation" \
    --prompt "$(cat "$PROMPT_FILE")" \
    "${EXTRA_ARGS[@]}"
fi
