# The Intelligent Harness — Autonomous Self-Healing Software

> **Part 1** introduced this as a self-healing incident-response loop. **Part 2** reframes the same system around the design decision that makes it work: the **intelligent harness**. This document carries the Part 2 framing. The Part 1 narrative is preserved in [`self-healing-loop.md`](self-healing-loop.md); the Part 2 essay is in [`intelligent-harness.md`](intelligent-harness.md).

## Core Concept

The intelligent harness is a pattern: **a general-purpose LLM orchestrator that offloads domain-specific work to cheap, purpose-built SLM tools instead of reasoning through it on every call.**

Most agentic systems ask one expensive model to do everything — read the crash log, reason about the domain, decide what to change, and apply the fix. That is several reasoning steps on expensive tokens, repeated from scratch on every incident. The harness separates the two jobs:

- **Coordination** stays with the orchestrator (Warp Oz). It is a general-purpose generalist: plan, edit files, run commands, verify, report.
- **Domain reasoning** moves into fine-tuned **SLM tools**. Each tool is a cheap specialist that recognizes one failure mode and returns a structured instruction.

The orchestrator never touches the domain problem directly. It calls a tool, gets back a 50-token JSON contract, and executes. Domain reasoning that used to cost thousands of expensive tokens becomes a function call.

### Architecture — Orchestrator, SLM Tools, Control Plane

This is the target architecture. The current repo implements the Worker-controlled demo with a Python example service, a single registered SLM tool, Durable Object incident state, and Warp Oz remediation. dlt and CI/CD closure are future integration points, not required for the current demo.

```
┌──────────────────────────────────────────────────────────┐
│                   PRODUCTION SYSTEM                       │
│          (services, gateways, microservices)             │
└────────────────────┬─────────────────────────────────────┘
                     │  traces / logs
                     ▼
┌──────────────────────────────────────────────────────────┐
│              CONTROL PLANE  (Cloudflare Worker)          │
│   Ingests events, recognizes failures, and ROUTES each   │
│   crash log to the SLM tool that owns its failure mode.  │
│   Stores durable jobs and exposes the orchestrator API.  │
│   Stays general-purpose — it never diagnoses anything.   │
└──────────────┬───────────────────────────────────────────┘
               │  crash log → matching tool
               ▼
┌──────────────────────────────────────────────────────────┐
│            SLM TOOLS  —  the cheap specialists           │
│   Fine-tuned Distil Labs SLMs, one per failure mode.     │
│   Each declares: a signature it matches, the model to    │
│   call, the prompt (input contract), and the structured  │
│   Diagnosis it returns (output contract).                │
│                                                          │
│   Add a failure mode → register another tool. The        │
│   orchestrator does not get smarter; the harness does.   │
└──────────────┬───────────────────────────────────────────┘
               │  5-field JSON Diagnosis (the contract)
               ▼
┌──────────────────────────────────────────────────────────┐
│         ORCHESTRATOR  —  Warp Oz ("The Hands")           │
│   An autonomous agentic CLI that:                        │
│                                                          │
│   1. Claims the structured diagnosis from the control    │
│      plane (it never sees the raw crash log)             │
│   2. Spins up a terminal environment                     │
│   3. Applies the scoped fix the contract specifies       │
│   4. Runs verification                                   │
│   5. Reports fixed/failed back to the control plane      │
└──────────────────────────────────────────────────────────┘
```

In this repo, the SLM tool registry lives in [`worker/src/harness.ts`](worker/src/harness.ts). The control plane in [`worker/src/index.ts`](worker/src/index.ts) routes to it via `selectTool()`.

### Key Design Decision

Coordination and domain reasoning are **deliberately decoupled**, and the boundary between them is a strict output contract:

- **Distil Labs SLM tools** stay small and fast — optimized purely for pattern recognition across one system's operational traces.
- **Warp Oz** handles multi-step agentic execution — file edits, shell commands, git operations, CI triggers.
- **The output contract** (a 5-field JSON `Diagnosis`) is the entire interface. Oz reads the fields and executes; it does not parse prose or judge correctness. The contract is also the trust boundary — Oz never sees the raw crash log, telemetry, or customer data.

This separation means each component can be fine-tuned, scaled, and upgraded independently, and the system scales by **adding tools, not by making the orchestrator smarter**.

### Net Effect

Reactive human on-call is replaced by a closed-loop self-healing cycle where the expensive model barely does any work:

**Observe → Route → Diagnose (SLM) → Fix (Oz) → Deploy** — measured in seconds, not hours, and at a fraction of the token cost of an all-LLM agent.

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

### Phase 1 — Current (Harness with one SLM tool)

- Python IoT gateway sends production-style telemetry to the Cloudflare Worker through `POST /api/telemetry`.
- Svelte dashboard on Cloudflare Pages triggers demo events through `POST /api/demo/telemetry` and watches incident state.
- The Worker control plane validates payloads, routes the crash log through the SLM tool registry (`selectTool`), calls the matching Distil tool, stores durable remediation jobs, and exposes the Oz job API.
- Warp Oz claims the job, applies the scoped fix, verifies it, and reports completion back to the Worker.

### Phase 1.5 — Multiple SLM tools

- Register additional tools in `worker/src/harness.ts` for other failure modes: dependency version conflicts, permission errors, certificate expirations, resource-limit breaches.
- The control plane already routes by failure signature, so a new tool needs only its own `matches`, `model`, `buildPrompt`, and `validate`. The orchestrator and the rest of the loop stay unchanged.
- Routing can itself graduate to an SLM tool — a classifier that reads the crash log and returns which specialist to invoke.

### Phase 2 — WebSocket Live Streaming

- Replace polling with a WebSocket connection from the dashboard to Warp Oz.
- Warp Oz terminal output (file edits, test runs, git operations) streams live into the browser.
- The audience watches the remediation happen in real time inside the dashboard — full "magic moment."

### Phase 3 — Full CI/CD Closure

- Warp Oz pushes the fix, triggers CI/CD, and the Worker's schema updates automatically on deploy.
- Dashboard reflects the pipeline going green end-to-end.
- dlt integration for real log streaming from production.
