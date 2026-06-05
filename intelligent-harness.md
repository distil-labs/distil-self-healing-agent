# Giving Superpowers to Your LLMs with SLMs

## Part 2 of the Autonomous Bug-Fixing Agent series
**Part 1:** [Autonomous Bug Fixing Agent with Distil Labs' SLM and Warp Oz](self-healing-loop.md)

---

In Part 1, we built an autonomous bug-fixing agent. A Distil Labs SLM diagnosed the failure, Warp's Oz agent applied the fix, and the whole loop closed in seconds. That post focused on the loop itself. This one focuses on the design decision that made it work: the orchestrator never touches the domain problem directly.

Most teams building agentic systems today ask the LLM to do everything. The orchestrator reads the crash log, reasons about what went wrong, figures out which file to change, decides on the correct value, and applies the fix. That is five reasoning steps on expensive tokens, repeated from scratch on every incident.

The Part 1 architecture does something different. Warp's Oz never reads the crash log. It calls a fine-tuned 0.6B model that already knows the domain, gets back a 50-token JSON instruction, and executes. The expensive orchestrator handles coordination. The cheap specialist handles pattern recognition.

That separation is what we call the intelligent harness. An LLM orchestrator that offloads domain-specific work to purpose-built SLM tools instead of reasoning through it every time. This post explains why the harness changes the economics and reliability of agentic systems, and how to build one using the Distil Labs platform and Warp Oz.

## Why orchestrators are expensive generalists

LLM-powered agents are good at coordination. Warp's Oz can plan terminal sessions, edit files, run commands, verify results, and report back. That general capability works across almost any codebase without fine-tuning.

But when the orchestrator hits a domain-specific task, it has no choice but to reason from scratch. Without specialist knowledge, it reads the full log, tries to infer schema conventions, guesses which file needs changing, and produces a fix based on general knowledge. Every token of that reasoning costs money, adds latency, and introduces a failure point.

The usual workaround is prompt engineering: longer system prompts, few-shot examples, retrieval pipelines. Each addition makes the agent slower, more expensive, and more fragile. You are paying the orchestrator to re-learn domain expertise on every single call.

Fine-tuning the orchestrator itself couples domain knowledge to the coordination layer. That means retraining every time either one changes. Expensive, slow, hard to validate.

The harness solves this differently. Keep the orchestrator general-purpose. Train cheap, fast SLM tools for the domain work. The orchestrator calls the tool, gets structured output, and acts. Domain reasoning that used to cost thousands of tokens becomes a function call that returns 50 tokens of JSON.

## The token economics

This is the core argument for the harness. The total token count matters less than which model burns them. With the harness, the expensive model barely does any work.

**Without the harness,** the entire incident runs on the orchestrator (in our case, Opus-class pricing). The token budget for a single incident:

| Component | Estimated tokens |
|---|---|
| System prompt (domain context, schema docs) | ~1,000 |
| Few-shot examples (2-3 correct diagnosis pairs) | ~2,000 |
| The crash log | ~400 |
| Chain-of-thought reasoning (output) | ~200 |
| Diagnosis + explanation (output) | ~100 |
| **Total on Opus** | **~3,700** |

At Opus pricing ($15/M input, $60/M output), that is roughly $0.07 per incident. At 10,000 failure events per day: $700/day. At 100,000 events: $7,000/day. And the system prompt and few-shot examples repeat identically on every call. You are paying the most expensive model available to re-read the same domain context thousands of times.

**With the harness,** two things happen. The orchestrator stops doing diagnosis entirely. It only reads the SLM's JSON output and acts on it, so its token count drops from ~3,700 to roughly 50. The SLM picks up the diagnosis work, and it does still need tokens: a system prompt plus the crash log, roughly ~1,200 tokens in and ~50 tokens out.

But SLM tokens cost approximately $0.15 per million, versus $15-60 per million for Opus. That is roughly 150x cheaper. So the SLM's ~1,250 tokens cost a fraction of a cent.

| Component | Tokens | Cost per incident |
|---|---|---|
| **Before:** Opus does everything | ~3,700 | ~$0.07 |
| **After:** Opus (reads JSON, acts) | ~50 | ~$0.00075 |
| **After:** SLM (diagnosis) | ~1,250 | ~$0.00019 |
| **After total** | ~1,300 | **~$0.001** |

The thing that collapsed is the Opus count: from 3,700 tokens down to 50. Those are the expensive tokens. The SLM ends up processing more tokens than you might expect, but it does not matter to the cost because SLM inference is 150x cheaper per token.

**At the same volume, side by side:** 10,000 events per day costs roughly $700/day without the harness. With the harness, the same 10,000 events costs under $10/day. That is not a marginal optimization. It is the difference between a system that requires budget approval and one that runs as infrastructure.

## The output contract

The harness works because the SLM tool and the orchestrator communicate through a strict contract, not free-form text.

In Part 1, the contract is a 5-field JSON object:

```json
{
  "root_cause": "schema_mismatch",
  "file": "config/demo_contract.json",
  "variable": "iot_gateway.approved_schema",
  "fix_action": "append",
  "new_value": "vibration_hz"
}
```

Oz reads the fields and executes. It does not evaluate whether the diagnosis is correct. It does not parse a paragraph of reasoning. The contract eliminates an entire class of failures that plague agent-LLM integrations: malformed output, inconsistent formats, output that requires interpretation.

This is where fine-tuning pays off most directly. A frontier model prompted to diagnose a crash log might return a paragraph, a code block, or JSON with different field names each time. A fine-tuned SLM produces the same structured format every time because that format was part of the training data. The orchestrator's integration code is a JSON read, not a parser.

The contract also defines the trust boundary. Oz only sees the 5-field instruction, not the full crash log, not raw telemetry, not customer data. The SLM tool processes the sensitive context and passes only the scoped action downstream. Privacy becomes a natural consequence of the harness architecture.

## Build your own harness

The harness has three components: an orchestrator, one or more SLM tools, and a control plane that routes between them.

For the orchestrator, we use [Warp Oz](https://www.warp.dev/oz). It handles multi-step execution: file edits, shell commands, verification, reporting. Any agentic CLI or framework that can consume structured JSON works here.

For the SLM tools, we use [Distil Labs](https://www.distillabs.ai/). The platform takes your operational data (crash logs, traces, failure patterns), expands seed examples into synthetic training data, and fine-tunes a model that produces the structured output your orchestrator needs. `massive-iot-traces1` was built from ~300 seed traces expanded to ~10,000 training examples in under 12 hours. The resulting 0.6B student model outperformed its 120B teacher by 29 percentage points on the target task, because the fine-tuning narrows the model to exactly the output format the harness needs rather than preserving general-purpose capability it will never use. For the full breakdown of the training process, accuracy benchmarks, and how we used dlt and Hugging Face in the pipeline, see [this post](https://www.distillabs.ai/blog/a-0-6b-model-outperformed-a-120b-llm-by-29-points---using-dlt-distil-labs-and-hugging-face/).

For the control plane, we use [Cloudflare Workers](https://workers.cloudflare.com/). The Worker ingests events, calls the right SLM tool, stores durable state, and exposes the job API that the orchestrator consumes.

Each SLM tool trains independently, deploys independently, and updates independently. Adding a new failure mode means training a new tool and registering it with the control plane. You do not retrain anything that already works. The harness scales by adding tools, not by making the orchestrator smarter.

The full Part 1 demo is open source: [GitHub repository](https://github.com/distil-labs/distil-self-healing-agent). To train your own SLM tools on your operational data, [get started with Distil Labs](https://www.distillabs.ai/docs/getting-started/cli).

## What's next

In Part 3, we will replace the polling-based architecture with [Apache Iggy](https://iggy.rs/), a persistent message streaming server, to make the entire harness operate in real time. Production events flow through Iggy, the right SLM tool triggers on ingestion, and the orchestrator's fix streams live into the dashboard as it happens. That post will show the system running against a continuous event stream rather than a single triggered failure.

## How the pieces fit together

[Distil Labs](https://www.distillabs.ai/) trains the SLM tools that give your orchestrator domain expertise. Your operational data becomes a fine-tuned specialist that produces structured output on demand. The platform handles synthetic data generation, training, and deployment.

[Warp Oz](https://www.warp.dev/oz) is the orchestrator. It coordinates multi-step workflows, calls SLM tools when it needs domain knowledge, and executes fixes autonomously in a sandboxed environment.

[Cloudflare Workers](https://workers.cloudflare.com/) runs the control plane. The Worker routes events, calls the right tool, stores durable state, and exposes the job API that Oz consumes.
