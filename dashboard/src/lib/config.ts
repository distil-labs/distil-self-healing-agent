// Worker API base URL — set via VITE_WORKER_URL env var.
// Local dev: Cloudflare Worker runs on port 8788 by default.
// Production: set to your deployed Worker URL.
export const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8788';
