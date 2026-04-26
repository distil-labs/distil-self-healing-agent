# From Bugs to Self-Healing Software: Fine-tuned SLMs and Agents Automate Debugging

*Stop chasing bugs. Discover how software can detect, diagnose, and fix failures before you are even pulled in.*

Something breaks in production.

Maybe it is a bad deploy. Maybe it is a schema mismatch. Maybe a downstream service changed behavior in a way your system did not expect. Whatever the cause, the experience is usually the same: alerts fire, logs pile up, and someone has to stop what they are doing to reconstruct the failure from a wall of operational data.

We have all lived this loop. It is the 2 a.m. wake-up call. It is the hotfix that steals time from the roadmap. It is the mental overhead of knowing the same class of issue may appear again next week.

That is the friction we wanted to attack.

This project is a practical look at a different incident-response model: one where observability, diagnosis, and remediation are connected into a closed loop.

At the center of that loop is a fine-tuned small language model built with Distil Labs. It is not acting as a general-purpose assistant. It is trained for a narrow operational job: read logs and traces, recognize a known failure pattern, and produce a structured diagnosis. Once that diagnosis exists, Warp's Oz agent takes over to apply the fix and move the incident to the next operational step.

The result is not "AI for debugging" in the abstract. It is a concrete engineering pattern for reducing the time between failure detection and verified response.

## Why This Matters

Modern systems already emit enormous amounts of telemetry. The problem is not a lack of signals. The problem is the distance between signal and action.

In most environments, the workflow still looks like this:

1. A failure occurs.
2. A human gets paged.
3. Someone searches logs and traces.
4. They form a hypothesis.
5. They reproduce the problem.
6. They edit code or config.
7. They validate the fix.
8. They push the change through CI/CD.
9. They watch production and hope the issue is actually closed.

Even when the fix is small, the workflow is expensive. It depends on the right person being available, having the right context, and making the right call under pressure.

That is where teams lose time. It is also where engineering throughput quietly disappears. The cost of incidents is not just downtime; it is the constant tax of reactive work.

The interesting opportunity is not to generate better explanations of failures. It is to compress the loop from *observe* to *respond*.

## The Core Design: Separate the Brain from the Hands

The system we built follows one simple engineering principle: diagnosis and remediation should be handled by different components with different responsibilities.

The fine-tuned SLM is the brain.

Its job is to read noisy operational evidence, classify the failure, and return a machine-usable diagnosis in a structured format.

Warp Oz is the hands.

Its job is to take that diagnosis and perform scoped execution: open the right context, apply the right change, verify the result, and hand the fix off to the rest of the delivery flow.

That separation matters for a few reasons.

First, the model stays narrow. It does not need to generate broad reasoning across arbitrary tasks. It needs to do one job well: map a known failure signature to a known remediation target.

Second, the execution layer stays explicit. The agent is not guessing what happened from raw logs. It is acting on a structured contract that tells it where to look and what to change.

Third, each layer can evolve independently. The model can be retrained as new failure patterns appear. The agent can gain new workflows, guardrails, and deployment hooks without changing the diagnosis layer.

Together, they create a closed loop:

> Observe -> Diagnose -> Fix -> Deploy

## How We Built It in Three Steps

### 1. Start with production logs and traces

Everything begins with observability data.

Applications already produce the raw material: logs, traces, errors, and event histories. But raw operational data is messy. It is noisy, inconsistent, and full of details that are useless for training unless the data is cleaned and grounded.

That is where dlt comes in. We use it to clean and organize production signals into training examples built around real failure patterns. Instead of treating logs as disposable output, we treat them as the source material for operational intelligence.

That shift is important. The same data that engineers use to debug incidents manually can be used to teach a model how those incidents look when they first emerge.

### 2. Fine-tune the SLM for operational diagnosis

Once the logs and traces are organized, we use Distil Labs' platform to fine-tune a small language model on those patterns.

This is the key distinction from simply pointing a large general-purpose model at a pile of logs.

Operational diagnosis is a narrow problem. We care about latency, consistency, domain vocabulary, and predictable output. We do not need a model that can discuss every topic on the internet. We need a model that understands how *this* system fails and how its downstream automation expects that failure to be described.

In the demo, the model looks at a failure log and returns a compact JSON diagnosis with fields like:

- root cause
- file to edit
- variable to update
- fix action
- corrected value

That structured output is what turns diagnosis into something an agent can act on safely.

### 3. Connect the diagnosis to Warp's Oz agent

Once the model has identified the issue, Warp Oz takes over.

Instead of routing the diagnosis to an engineer, we route it to an agent that can perform the mechanical response. Oz reads the structured result, opens the target file, applies the scoped change, validates the fix, and prepares the handoff to CI/CD or to the next operational checkpoint.

This is where the system stops looking like "AI that helps debugging" and starts looking like automation infrastructure.

The model is not just summarizing the incident. It is producing machine-usable intent.

The agent is not just generating text. It is executing a remediation workflow with a specific target and an expected verification path.

That is the closed loop.

## The Demo: A Realistic IoT Failure Mode

To make the architecture concrete, we built the demo around an industrial IoT gateway.

Imagine a factory environment where sensors report telemetry such as temperature and pressure through an MQTT-based gateway. The gateway validates incoming payloads against a strict allowlist.

Now imagine a sensor firmware update introduces a new field: `vibration_hz`.

The payload is still valid JSON. The device is still behaving correctly. But the gateway does not recognize the new field, so validation fails. The result is a schema mismatch, a critical error, and a process exit.

This is a useful example because it is both realistic and bounded.

It is realistic because schema drift and interface evolution happen constantly in production systems.

It is bounded because the root cause maps cleanly to a mechanical correction: update the approved schema to include the missing field.

In the demo, the loop works like this:

1. A telemetry payload arrives at the gateway.
2. The gateway rejects it because of the unexpected field.
3. The failure log is captured and passed to the fine-tuned SLM.
4. The SLM identifies the missing schema field and returns a structured diagnosis.
5. Warp Oz receives that diagnosis and applies the fix.
6. The system is ready to validate the change and continue the delivery flow.

That chain is the point of the demo. The goal is not just to explain the failure faster. The goal is to turn operational understanding into action.

## How We Divided the System

Although this project lives in a single codebase, we split it into distinct deployment surfaces with clean responsibilities. That separation keeps the demo understandable and keeps the runtime contract between components explicit.

### `dashboard/` — the operator-facing UI

The dashboard is a SvelteKit application deployed separately from the backend. Its job is to visualize the loop: demo event triggered, failure detected, diagnosis generated, Oz waiting to remediate.

It does not contain API logic. It is a presentation layer that talks to the worker over HTTP.

### `worker/` — the diagnosis and orchestration backend

The worker is a standalone Cloudflare Worker. It validates telemetry, generates a crash log for the demo failure, calls the Distil Labs model, and stores a durable remediation job for Oz to claim.

This is the operational backend of the system. It is where diagnosis becomes a programmatic interface rather than a human-only artifact.

### `iot-gateway/` — the intentionally failing production-style target

This directory contains the IoT gateway service and the reproduction script for the schema-mismatch incident.

The gateway is the thing that breaks. It is written in Python to represent an ordinary production service, while the self-healing control plane remains separate in the Worker, dashboard, and Oz handoff.

That matters because the demo is not framed around a toy prompt. It is framed around a failure inside a concrete service with a concrete remediation target.

### `scripts/` — the bridge into the agent workflow

The scripts directory contains the utility code that captures a diagnosis and hands it off to Oz via polling. This keeps the handoff simple and observable while the system is still in demo form.

### Why this split matters

We intentionally did not collapse everything into one monolith.

Keeping the UI, the backend, the target system, and the agent handoff separated makes the architecture easier to reason about. It also mirrors how a real deployment would evolve: different surfaces, different permissions, different lifecycles, one shared operational contract.

## Why Fine-Tuned SLMs Fit This Problem

A lot of AI infrastructure conversations jump straight to the biggest possible model. This is one of the clearest examples of why that instinct is often wrong.

Operational diagnosis is repetitive. It is pattern-heavy. It depends on system-specific vocabulary, failure signatures, and remediation conventions. Those are strong conditions for fine-tuning.

A fine-tuned SLM gives you:

- lower latency
- lower cost
- more predictable output
- better alignment with your environment
- cleaner compatibility with downstream automation

In other words, you do not need a model that knows everything. You need a model that knows your failures.

That is a more practical engineering target, and it is a better product target too. Teams do not buy "general intelligence" when they are on call. They buy faster recovery, tighter loops, and fewer repeated incidents.

## What Changes for Engineering Teams

If this pattern becomes common, incident response starts to change in a meaningful way.

Instead of every issue escalating immediately to a human, many classes of failures can be handled automatically. Engineers spend less time spelunking through logs and more time improving systems. On-call shifts away from manual triage and toward policy, supervision, and exception handling.

This does not mean humans disappear from the loop. It means humans move up the stack.

The most valuable engineers should not spend their best hours rediscovering the same root causes and reapplying the same mechanical fixes. They should be designing the guardrails, approval paths, and remediation policies that allow the common cases to resolve themselves.

That is what self-healing software means in practical terms. Not unlimited autonomy. Not vague AI magic. Just a tighter feedback loop for failures we already understand well enough to automate.

## What Comes Next

This demo is a starting point, not the end state.

The next step is to make the loop feel live: stream Oz's actions back into the UI, show validation in real time, and make remediation visible as it unfolds.

After that, the larger opportunity is to close the delivery loop completely so a diagnosed fix can move through validation and deployment with the right safeguards and approval boundaries.

The long-term vision is straightforward:

1. Your production system emits signals.
2. Your model interprets those signals in context.
3. Your agent performs the next safe operational step.
4. Your software recovers before the incident turns into a fire drill.

That is the future we are building toward with Distil Labs and Warp: not more dashboards about failure, but systems that can respond to failure directly.

## Closing

Debugging will always matter. But waking humans up to perform the same log analysis and the same mechanical fixes over and over again should not be the default operating model.

By combining cleaned operational data, fine-tuned small models, and agentic remediation, we can move from software that merely reports failures to software that responds to them.

That is the leap from bug detection to self-healing systems.
