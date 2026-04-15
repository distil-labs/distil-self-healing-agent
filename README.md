# Self-Healing Infrastructure Loop Demo

This repository contains a working demo of a self-healing incident-response loop built around three ideas:

1. production telemetry is the source material for diagnosis
2. a fine-tuned small language model can classify narrow operational failures quickly
3. an agent can act on a structured diagnosis and execute the remediation workflow

The current demo uses an industrial IoT schema-mismatch failure to show the loop end to end:

- a telemetry payload is rejected
- the failure is converted into a structured crash log
- a Distil Labs model produces a diagnosis
- Warp Oz polls for that diagnosis and applies the next operational step

## What This Repo Contains

The project is intentionally split into distinct surfaces rather than one large app.

### `dashboard/`

SvelteKit frontend for the demo UI.

- shows telemetry events
- shows the generated crash log
- shows the structured diagnosis
- publishes the diagnosis for Warp Oz to retrieve
- intended deployment target: Cloudflare Pages

### `worker/`

Cloudflare Worker backend.

- exposes the demo API
- validates telemetry payloads
- builds the diagnosis prompt
- calls the Distil Labs endpoint
- stores the latest diagnosis for Oz polling
- intended deployment target: Cloudflare Workers

### `iot-gateway/`

The intentionally failing "production" service used in the demo.

- `industrial_gateway.py` contains the strict schema validation
- `reproduce_crash.py` triggers the schema mismatch by sending `vibration_hz`

### `scripts/`

Helper scripts for local diagnosis and Oz handoff.

- `diagnose_crash.py` captures the failure log and calls the model directly
- `warp_oz_poll.py` polls the worker's `/api/diagnosis` endpoint and writes `diagnosis_output.json`

### Root-level docs

- `concept.md` — architecture overview and roadmap
- `warp_instructions.md` — expected Oz remediation flow
- `self-healing-loop.md` — publish-ready blog post for this demo

## Architecture

```text
┌──────────────┐       ┌──────────────────┐       ┌────────────┐
│ Dashboard    │──────▶│ Cloudflare       │──────▶│ Distil SLM │
│ SvelteKit UI │ HTTP  │ Worker API       │  HTTP │ Diagnosis  │
└──────┬───────┘       └────────┬─────────┘       └────────────┘
       │                        │
       │                        ▼
       │                 latest diagnosis
       │                        │
       ▼                        ▼
┌──────────────┐         ┌──────────────┐
│ IoT Gateway  │         │ Warp Oz      │
│ crash source │         │ polling/exec │
└──────────────┘         └──────────────┘
```

The control flow is:

1. the dashboard sends telemetry to the worker
2. the worker validates the payload and emits a demo crash log when schema validation fails
3. the worker calls the fine-tuned Distil Labs model to produce a structured diagnosis
4. the worker stores that diagnosis at `GET /api/diagnosis`
5. Warp Oz polls the diagnosis endpoint, consumes the result, and proceeds with remediation

## API Endpoints

The worker currently exposes these routes:

- `POST /api/telemetry` — validate a payload against the approved schema
- `POST /api/diagnose` — send a crash log to the Distil model
- `GET /api/diagnosis` — retrieve the latest stored diagnosis
- `POST /api/diagnosis` — store a diagnosis for Oz to consume
- `DELETE /api/diagnosis` — clear the stored diagnosis after consumption
- `GET /health` — basic health check

## Prerequisites

You will need:

- Node.js 18+ or newer
- Python 3.10+ or newer
- `npm`
- a Cloudflare account for deployment
- a Distil Labs-compatible inference endpoint and API key

## Local Development

### 1. Install Python dependencies

From the repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure root `.env` for the Python scripts

Create or update `.env` in the project root:

```env
DISTIL_ENDPOINT=https://your-inference-endpoint/v1/completions
DISTIL_API_KEY=your_api_key
DISTIL_MODEL=distillabs/massive-iot-traces1
```

These values are used by `scripts/diagnose_crash.py`.

### 3. Start the worker locally

```bash
cd worker
npm install
npm run dev
```

The dashboard expects the worker at `http://localhost:8788` by default.

### 4. Start the dashboard locally

In a second terminal:

```bash
cd dashboard
npm install
VITE_WORKER_URL=http://localhost:8788 npm run dev
```

### 5. Reproduce the failure locally

To reproduce the schema-mismatch crash directly:

```bash
cd iot-gateway
python3 reproduce_crash.py
```

### 6. Poll for a diagnosis as Oz

From the repo root:

```bash
source .venv/bin/activate
python3 scripts/warp_oz_poll.py
```

This polls the worker every few seconds, writes `diagnosis_output.json`, and clears the remote diagnosis after retrieval.

## Deployment

The demo is designed as two deployable surfaces: the worker and the dashboard.

### Deploy the worker

From `worker/`:

1. install dependencies
2. set the Distil API key as a Cloudflare secret
3. deploy with Wrangler

```bash
cd worker
npm install
npx wrangler secret put DISTIL_API_KEY
npm run deploy
```

Static worker vars already live in `worker/wrangler.toml`:

- `DISTIL_ENDPOINT`
- `DISTIL_MODEL`

After deployment, note the worker URL. You will use it as the dashboard backend.

### Deploy the dashboard

Deploy `dashboard/` as a Cloudflare Pages project.

Recommended setup:

- project root: `dashboard`
- install command: `npm install`
- build command: `npm run build`
- environment variable: `VITE_WORKER_URL=https://<your-worker>.workers.dev`

Because the dashboard uses `@sveltejs/adapter-cloudflare`, it is already configured for Cloudflare deployment targets. The dashboard remains frontend-only; all API logic lives in the worker.

## Notes and Current Limitations

- Diagnosis storage in the worker is in-memory today. It is fine for a demo, but not durable across worker restarts. A production version should move this to KV, D1, or another persistent store.
- The agent side is represented here by the polling handoff and documented remediation flow. A fully integrated Oz execution surface is the next step.
- The IoT scenario is intentionally narrow: it demonstrates the pattern with a failure that is easy to verify and easy to explain.
- The frontend and backend are intentionally separated so the runtime boundaries stay clear.

## Suggested Reading Order

If you are new to the project, read these in order:

1. `concept.md`
2. `warp_instructions.md`
3. `self-healing-loop.md`

Then look at:

- `worker/src/index.ts`
- `dashboard/src/routes/+page.svelte`
- `iot-gateway/industrial_gateway.py`

## License / Usage

No license file is currently included in this repository. Treat the contents as internal project material unless you add a license explicitly.
