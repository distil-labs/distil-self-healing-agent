#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
WARNINGS=0
RUN_CHECKS=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --checks)
      RUN_CHECKS=true
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  npm run doctor
  npm run doctor -- --checks

Validates local configuration for the self-healing demo. The default mode checks
files, required tools, and required env values. --checks also runs the project
type/build sanity checks.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

fail() {
  echo "✗ $1"
  FAILURES=$((FAILURES + 1))
}

warn() {
  echo "! $1"
  WARNINGS=$((WARNINGS + 1))
}

pass() {
  echo "✓ $1"
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

read_env_value() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 1
  fi
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- | tr -d '"'
}

require_command() {
  if has_command "$1"; then
    pass "$1 is installed"
  else
    fail "$1 is required"
  fi
}

require_file() {
  if [ -f "$ROOT_DIR/$1" ]; then
    pass "$1 exists"
  else
    fail "$1 is missing"
  fi
}

require_env_value() {
  local file="$1"
  local key="$2"
  local value
  value="$(read_env_value "$ROOT_DIR/$file" "$key" || true)"
  if [ -z "$value" ]; then
    fail "$file must define $key"
  elif [[ "$value" == your_* || "$value" == *"<"*">"* || "$value" == wk-your-* ]]; then
    fail "$file has placeholder value for $key"
  else
    pass "$file defines $key"
  fi
}

optional_env_value() {
  local file="$1"
  local key="$2"
  local value
  value="$(read_env_value "$ROOT_DIR/$file" "$key" || true)"
  if [ -n "$value" ] && [[ "$value" != your_* && "$value" != *"<"*">"* && "$value" != wk-your-* ]]; then
    pass "$file defines optional $key"
  else
    warn "$file does not define optional $key"
  fi
}

echo "[doctor] Checking required tools"
require_command node
require_command npm
require_command npx
require_command python3
require_command curl

if has_command oz; then
  pass "oz CLI is installed"
else
  warn "oz CLI is not installed or not on PATH; Oz remediation launch will not work locally"
fi

echo
echo "[doctor] Checking required files"
require_file package.json
require_file worker/wrangler.toml
require_file worker/package.json
require_file dashboard/package.json
require_file config/demo_contract.json
require_file oz/remediation_prompt.md
require_file scripts/run_oz_remediation.sh
require_file .env
require_file worker/.dev.vars
require_file dashboard/.env

echo
echo "[doctor] Checking env values"
require_env_value worker/.dev.vars DISTIL_API_KEY
require_env_value dashboard/.env VITE_WORKER_URL
optional_env_value .env WORKER_URL
optional_env_value worker/.dev.vars WARP_API_KEY
optional_env_value worker/.dev.vars OZ_ENVIRONMENT_ID
optional_env_value worker/.dev.vars WORKER_PUBLIC_URL

auto_trigger="$(read_env_value "$ROOT_DIR/worker/.dev.vars" OZ_AUTO_TRIGGER || true)"
if [ "$auto_trigger" = "true" ]; then
  require_env_value worker/.dev.vars WARP_API_KEY
  require_env_value worker/.dev.vars OZ_ENVIRONMENT_ID
  require_env_value worker/.dev.vars WORKER_PUBLIC_URL
else
  warn "OZ_AUTO_TRIGGER is not true; use POST /api/oz/trigger or npm run oz:cloud to start Oz"
fi

echo
echo "[doctor] Checking dependency folders"
if [ -d "$ROOT_DIR/worker/node_modules" ]; then
  pass "worker/node_modules exists"
else
  fail "worker dependencies are missing; run npm run setup"
fi

if [ -d "$ROOT_DIR/dashboard/node_modules" ]; then
  pass "dashboard/node_modules exists"
else
  fail "dashboard dependencies are missing; run npm run setup"
fi

if [ -d "$ROOT_DIR/.venv" ]; then
  pass ".venv exists"
else
  fail ".venv is missing; run npm run setup"
fi

if [ "$RUN_CHECKS" = true ]; then
  echo
  echo "[doctor] Running project checks"
  (cd "$ROOT_DIR/worker" && npx tsc --noEmit) && pass "worker typecheck passed" || fail "worker typecheck failed"
  (cd "$ROOT_DIR/dashboard" && npm run check) && pass "dashboard check passed" || fail "dashboard check failed"
  python3 -m py_compile \
    "$ROOT_DIR/iot-gateway/industrial_gateway.py" \
    "$ROOT_DIR/iot-gateway/reproduce_crash.py" \
    "$ROOT_DIR/iot-gateway/send_telemetry.py" \
    "$ROOT_DIR/scripts/diagnose_crash.py" \
    "$ROOT_DIR/scripts/warp_oz_poll.py" && pass "Python compile passed" || fail "Python compile failed"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "[doctor] FAILED with $FAILURES failure(s) and $WARNINGS warning(s)."
  exit 1
fi

echo "[doctor] OK with $WARNINGS warning(s)."
