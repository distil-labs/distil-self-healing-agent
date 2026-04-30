# Autonomous bug-fixing agent with Distil Labs SLM + Warp Oz

This repository contains a working demo of a self-healing incident-response loop built around three ideas:

1. production telemetry is the source material for diagnosis
2. a fine-tuned small language model can classify narrow operational failures quickly
3. an agent can act on a structured diagnosis and execute the remediation workflow

The current demo uses an industrial IoT schema-mismatch failure to show the loop end to end:

- a telemetry payload is rejected
- the failure is converted into a structured crash log
- a Distil Labs model produces a diagnosis
- Warp Oz polls for that diagnosis and applies the next operational step

## Known Scope

This is a focused self-healing software demo. It shows the full loop end to end with one concrete production-style failure.

- Python is the example production service. The Python IoT gateway is the application that breaks in the demo.
- Cloudflare Worker is the control plane. It validates telemetry, calls Distil, stores durable incident state, and exposes the Oz job API.
- Warp Oz performs remediation. Oz claims a durable job, edits the scoped target, runs verification, and reports completion.
- No auth is intentional for demo autonomy. The API is deliberately open so the demo can show software fixing a production-style bug without human approval gates.

## Run The Demo

This is the happy path for a fresh environment.

1. Set up the repo:

   ```bash
   npm run setup
   ```

2. Configure credentials:

   - Fill in Distil values in `worker/.dev.vars`.
   - Fill in `VITE_WORKER_URL` in `dashboard/.env` if you are not using the local default.
   - For Oz Cloud, set `WARP_API_KEY`, `OZ_ENVIRONMENT_ID`, and `WORKER_PUBLIC_URL` in Worker vars/secrets.

3. Deploy the Worker:

   ```bash
   npm run deploy:worker
   ```

4. Deploy the dashboard:

   ```bash
   VITE_WORKER_URL=https://<your-worker>.workers.dev npm run deploy:dashboard
   ```

5. Open the dashboard and trigger the bad telemetry demo event.

   Click `Send Bad Telemetry (vibration_hz)`. The dashboard asks the Worker to run the demo event; the Worker uses the shared bad payload, rejects it, calls Distil, and creates a durable remediation job.

   To exercise the production-service ingress path instead:

   ```bash
   WORKER_URL=https://<your-worker>.workers.dev python3 iot-gateway/send_telemetry.py
   ```

6. Trigger Oz:

   ```bash
   curl -s -X POST "https://<your-worker>.workers.dev/api/oz/trigger"
   ```

   Alternatively, set `OZ_AUTO_TRIGGER=true` so the Worker starts Oz automatically after diagnosis.

7. Watch the dashboard.

   The dashboard follows the durable incident state. Oz claims the job, applies the scoped fix, verifies it, and reports `fixed` or `failed`.

Optional preflight:

```bash
npm run doctor
```

Use this if setup or deployment fails, or if you want to check configuration before going live.

## What This Repo Contains

The project is intentionally split into distinct surfaces rather than one large app.

### `dashboard/`

SvelteKit frontend for the demo UI.

- shows telemetry events
- shows the generated crash log
- shows the structured diagnosis
- triggers demo events through the Worker API
- watches durable incident state from the Worker API
- intended deployment target: Cloudflare Pages

### `worker/`

Cloudflare Worker backend.

- exposes the demo API
- validates telemetry payloads
- builds the diagnosis prompt
- calls the Distil Labs endpoint
- stores durable remediation jobs for Oz
- triggers Oz Cloud when configured
- intended deployment target: Cloudflare Workers

### `iot-gateway/`

The intentionally failing example production service used in the demo.

This service is written in Python on purpose: Python represents the production application that breaks, not the platform backend. The self-healing control plane remains Worker-first; Python is here to make the incident concrete and easy to reproduce.

- `industrial_gateway.py` contains the strict schema validation and reads the active allowlist from `config/demo_contract.json`
- `reproduce_crash.py` triggers the schema mismatch by sending `vibration_hz`
- `send_telemetry.py` sends good or bad telemetry to the Worker ingest API and represents the production-service path

### `scripts/`

Helper scripts for local diagnosis and Oz handoff.

- `diagnose_crash.py` captures the failure log, sends it through the worker, publishes the result for Oz, and writes `diagnosis_output.json`
- `warp_oz_poll.py` polls the worker's `/api/diagnosis` endpoint and writes `diagnosis_output.json`
- `run_oz_remediation.sh` launches Warp Oz with the repo's remediation prompt

### `oz/`

Warp Oz integration assets.

- `remediation_prompt.md` is the prompt Oz uses to claim a remediation job, apply the scoped fix, verify it, and report completion through the Worker API

### `config/`

Shared demo contract used by every runtime surface.

- defines the active IoT allowlist
- defines the good and bad telemetry payloads
- defines the expected remediation target for the diagnosis contract

### Root-level docs

- `concept.md` — architecture overview and roadmap
- `warp_instructions.md` — expected Oz remediation flow
- `self-healing-loop.md` — publish-ready blog post for this demo

## Architecture

```text
┌────────────────┐
│ Dashboard UI   │
│ SvelteKit      │
└───────┬────────┘
        │ operator controls / watch incident state
        │
┌────────────────────────────────────────────┐
│ Cloudflare Worker API                      │
│ - ingests production events                │
│ - validates telemetry                      │
│ - calls Distil                             │
│ - creates durable remediation jobs         │
│ - triggers / serves Oz job API             │
└───────▲───────────┬───────────┬────────────┘
        │           │           │
        │ telemetry │ crash log │ durable job state
        │           ▼           ▼
┌───────┴────────┐  ┌────────────────┐      ┌────────────────────┐
│ Python IoT     │  │ Distil SLM     │      │ Durable Object     │
│ Gateway        │  │ Diagnosis      │      │ incidents / jobs   │
│ example prod   │  └───────┬────────┘      └────────┬───────────┘
└────────────────┘          │ structured diagnosis   │ claim job / report events
                            ▼                        ▼
                   ┌────────────────┐      ┌────────────────────┐
                   │ Worker stores  │◀────▶│ Warp Oz            │
                   │ diagnosis/job  │      │ remediation agent  │
                   └────────────────┘      └────────┬───────────┘
                                                     │ edit + verify
                                                     ▼
                                            ┌────────────────────┐
                                            │ Python IoT Gateway │
                                            │ example prod svc   │
                                            └────────────────────┘
```

The control flow is:

1. The example production service emits telemetry or an incident event to the Worker.
2. The Worker validates the payload and emits a crash log when schema validation fails.
3. The Worker sends the crash log to Distil and receives a structured diagnosis.
4. The Worker stores the diagnosis as a durable remediation job.
5. Warp Oz claims that job from the Worker, applies the scoped fix, verifies it, and reports events/completion back to the Worker.
6. The dashboard acts as an operator UI over the Worker API and watches durable incident state updates.

## API Endpoints

The worker currently exposes these routes:

- `POST /api/telemetry` — production-service telemetry ingest; rejected payloads are diagnosed and stored as durable remediation jobs
- `POST /api/demo/telemetry` — operator-triggered demo event used by the dashboard; runs the same Worker-side diagnosis/job pipeline
- `POST /api/diagnose` — send a crash log to the Distil model
- `POST /api/incidents` — create a durable remediation job from a diagnosis
- `GET /api/incidents/latest` — retrieve the latest durable incident/job state
- `GET /api/incidents/:id` — retrieve a specific durable incident/job
- `POST /api/remediation/next` — claim the next remediation job as Oz
- `POST /api/incidents/:id/events` — append Oz execution events
- `POST /api/incidents/:id/complete` — mark Oz remediation fixed or failed
- `POST /api/oz/trigger` — trigger an Oz Cloud run through Warp's HTTP Agent API
- `GET /api/oz/runs/:runId` — fetch Warp Oz Cloud run details
- `POST /api/incidents/:id/oz/sync` — sync Warp Oz run details onto the durable incident
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
- Warp Oz CLI (`oz`) for the remediation agent

## Local Development

### 1. One-command setup

From the repo root:

```bash
npm run setup
```

This installs Worker and dashboard dependencies, creates `.venv`, installs Python dependencies, and creates local env files from examples if they do not exist.

Fill in real Distil values after setup:

- `.env`
- `worker/.dev.vars`

Optional: validate the quickstart:

```bash
npm run doctor
```

For deeper local checks:

```bash
npm run doctor -- --checks
```

### 2. Start the local app

```bash
npm run dev
```

This starts the Worker and dashboard together. The Worker defaults to `http://localhost:8788`, and the dashboard uses that URL through `VITE_WORKER_URL`.

### 3. Optional: install Python dependencies manually

From the repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Configure root `.env` manually

Create or update `.env` in the project root:

```env
DISTIL_ENDPOINT=https://your-inference-endpoint/v1/completions
DISTIL_API_KEY=your_distil_api_key
DISTIL_MODEL=distillabs/massive-iot-traces1
```

These values are used by the worker and by `scripts/diagnose_crash.py --direct`.

### 5. Start the worker manually

```bash
cd worker
npm install
npm run dev
```

The dashboard expects the worker at `http://localhost:8788` by default.

### 6. Start the dashboard manually

In a second terminal:

```bash
cd dashboard
npm install
VITE_WORKER_URL=http://localhost:8788 npm run dev
```

### 7. Reproduce the failure locally

To reproduce the schema-mismatch crash directly:

```bash
python3 iot-gateway/reproduce_crash.py
```

### 8. Poll for a diagnosis as Oz

From the repo root:

```bash
source .venv/bin/activate
python3 scripts/warp_oz_poll.py
```

This polls the worker every few seconds, writes `diagnosis_output.json`, and clears the remote diagnosis after retrieval.

### 9. Launch Warp Oz Remediation

After a diagnosis has created a durable remediation job, launch Oz from the repo root:

```bash
npm run oz:local
```

This uses the Warp `oz` CLI directly. No SDKs are involved. Oz reads `oz/remediation_prompt.md`, claims `POST /api/remediation/next`, applies the scoped fix, runs verification, and reports events/completion back to the Worker.

For headless/cloud Oz execution:

```bash
export WORKER_URL=https://self-healing-api.<account>.workers.dev
export WARP_API_KEY=wk-your-warp-api-key
export OZ_ENVIRONMENT_ID=your_oz_environment_id
npm run oz:cloud
```

To trigger Oz Cloud from the Worker instead of launching the CLI yourself, configure `worker/.dev.vars` locally or Worker secrets/vars in production:

```env
WARP_API_KEY=wk-your-warp-api-key
OZ_ENVIRONMENT_ID=your_oz_environment_id
WORKER_PUBLIC_URL=https://self-healing-api.<account>.workers.dev
OZ_AUTO_TRIGGER=false
```

Then trigger the latest durable remediation job:

```bash
curl -s -X POST "$WORKER_URL/api/oz/trigger"
```

Set `OZ_AUTO_TRIGGER=true` to start an Oz Cloud run automatically after any Worker-side diagnosis creates a job, including `/api/telemetry`, `/api/demo/telemetry`, and `/api/diagnose`.

Oz results are received in two ways:

- Oz posts execution events and fixed/failed completion to this Worker through `POST /api/incidents/:id/events` and `POST /api/incidents/:id/complete`.
- The Worker can sync Warp Cloud run metadata, including state and `session_link`, with `POST /api/incidents/:id/oz/sync`.

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
npx wrangler secret put WARP_API_KEY
npx wrangler secret put OZ_ENVIRONMENT_ID
npm run deploy
```

Static worker vars already live in `worker/wrangler.toml`:

- `DISTIL_ENDPOINT`
- `DISTIL_MODEL`
- `OZ_AGENT_API_URL`
- `OZ_AGENT_RUNS_API_URL`
- `OZ_AUTO_TRIGGER`

Set `WORKER_PUBLIC_URL` to your deployed Worker URL if you use `/api/oz/trigger` from environments where request origin may not match the public URL.

After deployment, note the worker URL. You will use it as the dashboard backend.

### Deploy the dashboard

Deploy `dashboard/` as a Cloudflare Pages project.

Recommended setup:

- project root: `dashboard`
- install command: `npm install`
- build command: `npm run build`
- environment variable: `VITE_WORKER_URL=https://<your-worker>.workers.dev`

Because the dashboard uses `@sveltejs/adapter-cloudflare`, it is already configured for Cloudflare deployment targets. The dashboard remains frontend-only; all API logic lives in the worker.

You can also deploy from the repo root:

```bash
npm run deploy:worker
VITE_WORKER_URL=https://<your-worker>.workers.dev npm run deploy:dashboard
```

## Notes and Current Limitations

- Diagnosis and remediation job state is backed by a Durable Object.
- The agent side is represented by an API contract for Oz to claim, emit events, and complete remediation jobs.
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

MIT

Copyright (c) 2026 Distil Labs
