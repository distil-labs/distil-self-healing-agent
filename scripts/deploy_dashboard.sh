#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to deploy the dashboard." >&2
  exit 1
fi

if [ -z "${VITE_WORKER_URL:-}" ]; then
  echo "Set VITE_WORKER_URL to your deployed Worker URL before deploying dashboard." >&2
  echo "Example: VITE_WORKER_URL=https://self-healing-api.<account>.workers.dev npm run deploy:dashboard" >&2
  exit 1
fi

cd "$ROOT_DIR/dashboard"

echo "[deploy:dashboard] Building dashboard with VITE_WORKER_URL=$VITE_WORKER_URL"
npm run build

echo "[deploy:dashboard] Deploying .svelte-kit/cloudflare to Cloudflare Pages..."
npx wrangler pages deploy .svelte-kit/cloudflare --project-name "${PAGES_PROJECT_NAME:-distil-warp-dashboard}"
