# Autonomous bug-fixing agent with Distil Labs SLM + Warp Oz

> **Blog series.** **Part 1** — [Autonomous Bug Fixing Agent with Distil Labs' SLM and Warp Oz](self-healing-loop.md) — built the self-healing loop. **Part 2** — [The Intelligent Harness](intelligent-harness.md) — reframes the same system around the design decision that makes it work. This repo carries the Part 2 framing in code and docs.

This repository contains a working demo of **the intelligent harness**: a general-purpose LLM orchestrator that offloads domain-specific work to cheap, fine-tuned SLM tools instead of reasoning through it on every call.

The demo is built around three ideas:

1. a general-purpose **orchestrator** (Warp Oz) coordinates the fix but never touches the domain problem directly
2. a fine-tuned **SLM tool** (Distil Labs) is the cheap specialist — it recognizes one narrow failure mode and returns a structured diagnosis
3. a **control plane** (Cloudflare Worker) routes each failure to the tool that owns it, stores durable state, and exposes the job API the orchestrator consumes

The current demo uses an industrial IoT schema-mismatch failure to show the loop end to end:

- a telemetry payload is rejected
- the failure is converted into a structured crash log
- the control plane routes the crash log to the matching SLM tool, which produces a diagnosis
- Warp Oz claims that diagnosis and applies the next operational step

The point of Part 2 is that the orchestrator's domain reasoning — thousands of expensive tokens repeated on every incident — collapses into a function call that returns ~50 tokens of JSON. The system scales by **adding tools, not by making the orchestrator smarter**.

## The intelligent harness

The harness has three roles, each kept separate on purpose:

- **Orchestrator (Warp Oz).** A general-purpose agentic CLI. It plans, edits files, runs commands, verifies, and reports — across almost any codebase without fine-tuning. It never reads the crash log and never reasons about the domain.
- **SLM tools (Distil Labs).** Cheap, fast specialists. Each tool owns one failure mode and declares four things — the signature it `matches`, the `model` to call, the prompt it builds (input contract), and the structured `Diagnosis` it returns (output contract). The registry lives in [`worker/src/harness.ts`](worker/src/harness.ts).
- **Control plane (Cloudflare Worker).** Routes each crash log to the tool that owns it via `selectTool()`, stores durable jobs, and exposes the orchestrator API. It stays general-purpose — it never diagnoses anything itself.

### The output contract

The harness works because the SLM tool and the orchestrator communicate through a strict contract, not free-form text. In this demo the contract is a 5-field JSON object:

```json
{
  "root_cause": "schema_mismatch",
  "file": "config/demo_contract.json",
  "variable": "iot_gateway.approved_schema",
  "fix_action": "append",
  "new_value": "vibration_hz"
}
```

Oz reads the fields and executes — it does not parse a paragraph of reasoning or evaluate whether the diagnosis is correct. The contract eliminates a whole class of agent-LLM integration failures (malformed output, inconsistent formats, output that needs interpretation) because a fine-tuned SLM emits the same shape every time. It is also the **trust boundary**: Oz only ever sees the 5-field instruction, never the raw crash log, telemetry, or customer data.

### Why it is cheaper

Without the harness, the entire incident runs on the expensive orchestrator: system prompt, few-shot examples, the crash log, chain-of-thought, and output — on the order of thousands of frontier-model tokens, repeated identically on every incident. With the harness, the orchestrator's count collapses to the ~50-token JSON it reads and acts on; the diagnosis tokens move to an SLM that costs ~150× less per token. At 10,000 events/day that is the difference between hundreds of dollars a day and under ten. The full breakdown is in [`intelligent-harness.md`](intelligent-harness.md).

## Known Scope

This is a focused self-healing software demo. It shows the full harness loop end to end with one concrete production-style failure and one registered SLM tool.

- Python is the example production service. The Python IoT gateway is the application that breaks in the demo.
- The Cloudflare Worker is the control plane. It validates telemetry, routes the crash log to the matching SLM tool, stores durable incident state, and exposes the Oz job API.
- A Distil Labs SLM tool is the domain specialist. It diagnoses the IoT schema-mismatch failure and returns the structured contract.
- Warp Oz is the orchestrator. It claims a durable job, edits the scoped target, runs verification, and reports completion.
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

Cloudflare Worker backend — the harness control plane.

- `src/harness.ts` — the **SLM tool registry**. Defines the `Diagnosis` output contract, the `SlmTool` interface, the registered tools (`SLM_TOOLS`), and `selectTool()`. This is where the harness scales: add a failure mode by registering another tool here.
- `src/index.ts` — the control plane. Exposes the demo API, validates telemetry payloads, routes each crash log to the matching SLM tool via `selectTool()`, calls that tool's model, stores durable remediation jobs for Oz, and triggers Oz Cloud when configured.
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

- `concept.md` — architecture overview and roadmap (intelligent-harness framing)
- `intelligent-harness.md` — Part 2 blog post: the harness pattern, token economics, and the output contract
- `self-healing-loop.md` — Part 1 blog post for this demo
- `warp_instructions.md` — expected Oz remediation flow

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
3. The Worker routes the crash log to the SLM tool that owns its failure signature (`selectTool`), calls that tool's Distil model, and receives a structured diagnosis.
4. The Worker stores the diagnosis as a durable remediation job.
5. Warp Oz claims that job from the Worker, applies the scoped fix, verifies it, and reports events/completion back to the Worker.
6. The dashboard acts as an operator UI over the Worker API and watches durable incident state updates.

## API Endpoints

The worker currently exposes these routes:

- `POST /api/telemetry` — production-service telemetry ingest; rejected payloads are diagnosed and stored as durable remediation jobs
- `POST /api/demo/telemetry` — operator-triggered demo event used by the dashboard; runs the same Worker-side diagnosis/job pipeline
- `POST /api/diagnose` — route a crash log to the matching SLM tool and return its structured diagnosis
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
2. `intelligent-harness.md`
3. `warp_instructions.md`
4. `self-healing-loop.md`

Then look at:

- `worker/src/harness.ts` — the SLM tool registry (start here for the harness pattern)
- `worker/src/index.ts` — the control plane that routes to the tools
- `dashboard/src/routes/+page.svelte`
- `iot-gateway/industrial_gateway.py`

## License / Usage

MIT

Copyright (c) 2026 Distil Labs
