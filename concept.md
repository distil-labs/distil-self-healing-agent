# Autonomous Self-Healing Software Loop

## Core Concept

The Autonomous Self-Healing Software Loop is an architecture where **observability and remediation are linked by specialized intelligence rather than human intervention**.

Traditional production incident response follows a slow, manual chain: an alert fires, a human gets paged, they read logs, diagnose the issue, write a fix, and push it through CI/CD. This system replaces that entire chain with a closed loop that operates in seconds.

### Architecture — Three Layers

This is the target architecture. The current repo implements the Worker-controlled demo loop with a Python example service, Distil diagnosis, Durable Object incident state, and Warp Oz remediation. dlt and CI/CD closure are future integration points, not required for the current demo.

```
┌──────────────────────────────────────────────────────────┐
│                   PRODUCTION SYSTEM                      │
│          (services, gateways, microservices)              │
└────────────────────┬─────────────────────────────────────┘
                     │  traces / logs
                     ▼
┌──────────────────────────────────────────────────────────┐
│              INGESTION / CONTROL LAYER                    │
│   Streams production events into the Worker control       │
│   plane, where they become diagnosis and remediation      │
│   jobs. dlt can be added here for broader log pipelines.  │
└────────────────────┬─────────────────────────────────────┘
                     │  structured log events
                     ▼
┌──────────────────────────────────────────────────────────┐
│          DIAGNOSIS LAYER  —  "The Brain"                  │
│   A Distil Labs SLM (Small Language Model), fine-tuned    │
│   on the system's specific operational patterns.          │
│                                                           │
│   - Parses noisy, high-volume log streams                 │
│   - Identifies root cause instantly                       │
│   - Outputs a structured diagnosis (JSON)                 │
└────────────────────┬─────────────────────────────────────┘
                     │  structured diagnosis
                     ▼
┌──────────────────────────────────────────────────────────┐
│         REMEDIATION LAYER  —  "The Hands"                 │
│   Warp Oz — an autonomous agentic CLI that:               │
│                                                           │
│   1. Receives the structured diagnosis                    │
│   2. Spins up a terminal environment                      │
│   3. Reproduces the failure                               │
│   4. Applies a verified code fix                          │
│   5. Reports verification back to the control plane       │
└──────────────────────────────────────────────────────────┘
```

### Key Design Decision

Diagnosis and remediation are **deliberately decoupled**:

- **Distil Labs SLM** stays small and fast — optimized purely for pattern recognition across operational traces.
- **Warp Oz** handles multi-step agentic execution — file edits, shell commands, git operations, CI triggers.

This separation means each component can be fine-tuned, scaled, and upgraded independently.

### Net Effect

Reactive human on-call is replaced by a closed-loop self-healing cycle:

**Observe → Diagnose → Fix → Deploy** — measured in seconds, not hours.

---

## Use Case 1: Industrial IoT Gateway — Schema Evolution Crash

### Scenario

An industrial factory runs IoT sensors that report telemetry (temperature, pressure) through an MQTT-based gateway. A firmware update on the sensors introduces a **new field** (`vibration_hz`) that the gateway's strict schema validation does not recognize. The gateway crashes in production.

In this demo, the gateway is intentionally implemented as a Python production service. Python is not the self-healing platform backend; it is the example application under remediation.

### Why This Use Case

- It's a realistic, common failure mode in IoT systems (schema evolution mismatch).
- The error signature is clean and well-defined — ideal for SLM fine-tuning.
- The fix is mechanical (add the new field to an allowlist) — ideal for agentic remediation.
- A Distil Labs model (`massive-iot-traces1`) is already available, fine-tuned on IoT trace patterns.

### Components Built

| File                        | Role                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| `config/demo_contract.json` | Shared schema, demo payloads, and remediation target               |
| `industrial_gateway.py`     | Gateway service with strict approved-schema validation             |
| `reproduce_crash.py`        | Sends a payload with `vibration_hz` to trigger the schema mismatch |
| `send_telemetry.py`         | Sends good or bad telemetry to the Worker production-ingest path   |

### The Failure

The gateway validates incoming JSON against the shared allowlist:

```json
"approved_schema": ["device_id", "temp", "pressure"]
```

When a sensor sends `{"device_id": "plc-conveyor-07", "temp": 81.3, "pressure": 1.02, "vibration_hz": 42.7}`, the gateway logs:

```
CRITICAL SCHEMA_MISMATCH: Unexpected field 'vibration_hz' detected in MQTT topic 'factory/v3/telemetry'
```

And exits with code 1.

### The Self-Healing Flow

1. The Python gateway sends telemetry to the Cloudflare Worker through `POST /api/telemetry`, or the dashboard triggers the same demo event through `POST /api/demo/telemetry`.
2. The Worker rejects the schema mismatch, creates a crash log, and sends it to **Distil Labs SLM** (`massive-iot-traces1`), which produces a structured diagnosis:
   - Root cause: the shared approved schema is missing `vibration_hz`
   - File: `config/demo_contract.json`
   - Fix: append `"vibration_hz"` to `iot_gateway.approved_schema`
3. The Worker stores the diagnosis as a durable remediation job.
4. **Warp Oz** claims the job, edits the shared schema file, validates the fix by re-running `reproduce_crash.py`, and reports `fixed` or `failed` back to the Worker.

The gateway is back online — no human paged, no downtime.

---

## Roadmap

### Phase 1 — Current (Worker-Controlled Loop)

- Python IoT gateway sends production-style telemetry to the Cloudflare Worker through `POST /api/telemetry`.
- Svelte dashboard on Cloudflare Pages triggers demo events through `POST /api/demo/telemetry` and watches incident state.
- Worker validates payloads, calls Distil Labs SLM on crash, stores durable remediation jobs, and exposes the Oz job API.
- Warp Oz claims the job, applies the scoped fix, verifies it, and reports completion back to the Worker.

### Phase 2 — WebSocket Live Streaming

- Replace polling with a WebSocket connection from the dashboard to Warp Oz.
- Warp Oz terminal output (file edits, test runs, git operations) streams live into the browser.
- The audience watches the remediation happen in real time inside the dashboard — full "magic moment."

### Phase 3 — Full CI/CD Closure

- Warp Oz pushes the fix, triggers CI/CD, and the Worker's schema updates automatically on deploy.
- Dashboard reflects the pipeline going green end-to-end.
- dlt integration for real log streaming from production.
