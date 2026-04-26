# Warp Oz — Remediation Agent Instructions

## Role

Warp Oz is the **"Hands"** of the Self-Healing Infrastructure Loop. It claims a durable remediation job from the Cloudflare Worker, applies the scoped fix, verifies it, and reports the result back to the Worker.

## Input

Warp Oz's primary input is the Worker's durable job API:

```bash
POST /api/remediation/next
```

Legacy helper scripts can still write `diagnosis_output.json` for local debugging, but the current demo path uses the Worker job.

Expected job fields:

```json
{
  "id": "string — durable incident id",
  "target_file": "string — exact filename to edit, e.g. config/demo_contract.json",
  "target_variable": "string — exact JSON path to modify, e.g. iot_gateway.approved_schema",
  "fix_action": "string — what to do, e.g. append 'vibration_hz' to the list",
  "new_value": "string | array | object — the corrected value after the fix",
  "verify_command": "string — command to run from the repo root"
}
```

## Remediation Steps

Execute these steps **in order**:

### Step 1 — Read the Diagnosis

1. Claim the next job from the Worker:
   ```bash
   curl -s -X POST "$WORKER_URL/api/remediation/next"
   ```
2. If the response status is `empty`, stop.
3. Extract `job.id`, `job.target_file`, `job.target_variable`, `job.fix_action`, `job.new_value`, and `job.verify_command`.
4. If any required field is missing, report failure through `POST /api/incidents/:id/complete`.

### Step 2 — Locate the Target

1. Open the file specified in `job.target_file` (e.g. `config/demo_contract.json`).
2. Find the JSON path specified in `job.target_variable` (e.g. `iot_gateway.approved_schema`).
3. Confirm the path exists and its current value matches expectations from the job context.

### Step 3 — Apply the Fix

1. Modify the variable according to `job.fix_action`.
   - For this IoT use case, the typical fix is appending a missing field name to the shared `iot_gateway.approved_schema` list.
   - Example: change `"approved_schema": ["device_id", "temp", "pressure"]` to `"approved_schema": ["device_id", "temp", "pressure", "vibration_hz"]`.
2. Save the file.
3. Do **not** modify any other code or variables.

### Step 4 — Verify the Fix

1. Run `job.verify_command` from the repo root. For this demo, that is:
   ```bash
   python3 iot-gateway/reproduce_crash.py
   ```
2. Expected result after fix:
   - **No** `CRITICAL SCHEMA_MISMATCH` in the output.
   - Exit code **0**.
   - Log line: `Payload validated successfully for topic 'factory/v3/telemetry'`
   - Log line: `Telemetry accepted: ...`
3. If the reproduction still fails, **stop** and report the error — do not retry blindly.

### Step 5 — Report Completion

1. If verification passes, report success:
   ```bash
   curl -s -X POST "$WORKER_URL/api/incidents/$JOB_ID/complete" \
     -H "Content-Type: application/json" \
     -d '{"status":"fixed","summary":"Verification passed after remediation."}'
   ```
2. If verification fails, report failure:
   ```bash
   curl -s -X POST "$WORKER_URL/api/incidents/$JOB_ID/complete" \
     -H "Content-Type: application/json" \
     -d '{"status":"failed","summary":"Verification failed after remediation."}'
   ```

## Important Constraints

- **Scope**: Only modify the file and variable specified in the diagnosis. Do not refactor, reformat, or add features.
- **Idempotency**: Before appending a value, check it is not already present.
- **Failure handling**: If verification (Step 4) fails, stop and report `failed` to the Worker with the verification output.
- **No secrets**: Never log or commit API keys or `.env` contents.

## How Warp Oz Receives the Diagnosis

Warp Oz claims a durable remediation job from the Cloudflare Worker. No Python servers, no webhooks — everything goes through the Worker.

1. Launch Oz from this repo:
   ```bash
   npm run oz:local
   ```
2. The launcher calls the Warp `oz` CLI with `oz/remediation_prompt.md`.
3. Oz claims `POST /api/remediation/next`.
4. The response is a durable remediation job with the target file, JSON path, new value, verification command, and expected result.
5. Oz applies the target update, runs the verification command, emits execution events to `POST /api/incidents/:id/events`, and marks the incident fixed or failed with `POST /api/incidents/:id/complete`.
6. The dashboard watches durable incident state through `GET /api/incidents/:id`.
7. The Worker can sync Warp Cloud run metadata with `POST /api/incidents/:id/oz/sync`, including the run state and session link.

Alternatively, Warp Oz can poll directly via curl:
```bash
curl -s -X POST https://self-healing-api.<account>.workers.dev/api/remediation/next
```

For headless/cloud Oz execution, configure:

```bash
export WORKER_URL=https://self-healing-api.<account>.workers.dev
export WARP_API_KEY=wk-your-warp-api-key
export OZ_ENVIRONMENT_ID=your_oz_environment_id
npm run oz:cloud
```

The Worker can also trigger Oz Cloud directly:

```bash
curl -s -X POST "$WORKER_URL/api/oz/trigger"
```

For automatic cloud triggering after diagnosis, set these Worker values:

```env
WARP_API_KEY=wk-your-warp-api-key
OZ_ENVIRONMENT_ID=your_oz_environment_id
WORKER_PUBLIC_URL=https://self-healing-api.<account>.workers.dev
OZ_AUTO_TRIGGER=true
```

## Architecture

Frontend and backend are **fully separated**:

- **Frontend** (Cloudflare Pages) — SvelteKit dashboard in `dashboard/`. Operator UI only: triggers demo events and watches Worker state.
- **Backend** (Cloudflare Worker) — Standalone Worker in `worker/`. All API routes, telemetry validation, SLM calls, durable incident storage, and Oz trigger/result routes.
- **Example production service** — Python IoT gateway in `iot-gateway/`, which can send telemetry through `POST /api/telemetry`.
- **Oz delivery** — Warp Oz claims the Worker's `POST /api/remediation/next`, edits the scoped target, verifies, and reports back.

```
┌──────────────┐       ┌──────────────────┐       ┌────────────┐
│   Dashboard  │──────▶│  Cloudflare      │◀──────│  Python    │
│   (Pages)    │ demo  │  Worker (API)    │ HTTP  │  Gateway   │
│   Svelte UI  │◀──────│  /api/demo/...   │       │ /api/tele. │
└──────────────┘ state │  /api/telemetry  │       └────────────┘
                       │  /api/remed/...  │
                       └────────┬─────────┘
                                │ job claim/events/complete
                                ▼
                         ┌────────────┐
                         │  Warp Oz   │
                         │  agent     │
                         └────────────┘
```

## Project File Layout

```
distil-warp/
├── iot-gateway/                 ← "Production" IoT code (the thing that breaks)
│   ├── industrial_gateway.py    ← Gateway that reads the shared approved schema
│   └── reproduce_crash.py       ← Sends payload with vibration_hz to trigger crash
├── config/
│   └── demo_contract.json       ← Shared schema, demo payloads, and remediation contract
├── worker/                      ← Cloudflare Worker (Backend API)
│   ├── src/index.ts             ← All API routes, SLM calls, diagnosis storage
│   ├── wrangler.toml            ← Worker config + secrets
│   └── package.json
├── dashboard/                   ← SvelteKit app (Frontend only — Cloudflare Pages)
│   ├── src/lib/config.ts        ← VITE_WORKER_URL points to the Worker
│   ├── src/routes/+page.svelte  ← Dashboard UI
│   ├── svelte.config.js         ← adapter-cloudflare (Pages, no API routes)
│   └── package.json
├── scripts/                     ← Utility scripts
│   ├── diagnose_crash.py        ← Captures crash and routes diagnosis through the Worker
│   ├── run_oz_remediation.sh    ← Launches Warp Oz with the remediation prompt
│   └── warp_oz_poll.py          ← Legacy diagnosis polling helper
├── oz/
│   └── remediation_prompt.md    ← Oz job-claim/apply/verify/complete protocol
├── diagnosis_output.json        ← SLM output consumed by Warp Oz
├── concept.md                   ← Architecture overview
├── warp_instructions.md         ← This file
├── requirements.txt             ← Python dependencies
├── .env                         ← API keys (gitignored)
└── .venv/                       ← Python virtual environment (gitignored)
```

The Python gateway is the example production service under remediation. It is not the self-healing control plane; the Worker, diagnosis handoff, and Oz workflow remain the platform path.
