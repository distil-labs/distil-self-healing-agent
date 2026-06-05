/**
 * The intelligent harness — SLM tool registry and routing.
 *
 * Part 2 framing. The control plane (this Worker) and the orchestrator (Warp Oz)
 * stay general-purpose. Domain expertise lives in cheap, fine-tuned SLM *tools*.
 *
 * Each tool owns exactly one failure mode and declares four things:
 *   - `matches`     how to recognize the failure from its crash-log signature
 *   - `model`       which fine-tuned SLM the control plane should call
 *   - `buildPrompt` the input contract (crash log in)
 *   - `validate`    the output contract (structured `Diagnosis` out)
 *
 * The orchestrator never touches the domain problem. It acts on the 5-field
 * `Diagnosis` the tool returns. Adding a new failure mode means registering
 * another tool in `SLM_TOOLS` — not making the orchestrator smarter, and not
 * retraining anything that already works.
 */

import demoContract from '../../config/demo_contract.json';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * The output contract between an SLM tool and the orchestrator.
 *
 * Oz reads these five fields and executes. It does not parse prose or evaluate
 * whether the diagnosis is correct — the contract is the entire interface, and
 * also the trust boundary: Oz never sees the raw crash log or telemetry.
 */
export interface Diagnosis {
	root_cause: string;
	file: string;
	variable: string;
	fix_action: string;
	new_value: JsonValue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true;
	if (['string', 'number', 'boolean'].includes(typeof value)) return true;
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (isRecord(value)) return Object.values(value).every(isJsonValue);
	return false;
}

export function isDiagnosis(value: unknown): value is Diagnosis {
	if (!isRecord(value)) return false;
	return (
		typeof value.root_cause === 'string' &&
		typeof value.file === 'string' &&
		typeof value.variable === 'string' &&
		typeof value.fix_action === 'string' &&
		isJsonValue(value.new_value)
	);
}

// ─── IoT schema-mismatch tool ────────────────────────────
// The one tool shipped in this demo. Backed by `massive-iot-traces1`, a 0.6B
// model fine-tuned to diagnose IoT gateway schema-evolution failures.

const GATEWAY_CONTRACT = demoContract.iot_gateway;
const DIAGNOSIS_CONTRACT = demoContract.diagnosis;
const APPROVED_FIELDS = GATEWAY_CONTRACT.approved_schema;
const MQTT_TOPIC = GATEWAY_CONTRACT.mqtt_topic;

function buildCodebaseContext(): string {
	return [
		'CODEBASE MANIFEST:',
		`- File: ${GATEWAY_CONTRACT.schema_file}`,
		`  - Field: ${GATEWAY_CONTRACT.schema_path} = ${JSON.stringify(APPROVED_FIELDS)}`,
		`  - Remediation: ${DIAGNOSIS_CONTRACT.fix_action}`,
		`  - Updated value: ${JSON.stringify(DIAGNOSIS_CONTRACT.new_value)}`,
		`- File: ${GATEWAY_CONTRACT.file}`,
		`  - MQTT topic: ${MQTT_TOPIC}`,
		`  - Behavior: ${GATEWAY_CONTRACT.behavior}`,
		`- File: iot-gateway/reproduce_crash.py`,
		`  - Sends test payload: ${JSON.stringify(demoContract.payloads.bad)}`,
	].join('\n');
}

function buildIotSchemaPrompt(crashLog: string): string {
	const codebaseContext = buildCodebaseContext();

	return (
		'You are an IoT infrastructure diagnostics engine.\n' +
		'You have access to the following codebase information:\n\n' +
		codebaseContext +
		'\n\n--- CRASH LOG ---\n' +
		crashLog.trim() +
		'\n--- END LOG ---\n\n' +
		'Analyze the crash log above. Using ONLY the files and variables listed ' +
		'in the CODEBASE MANIFEST, produce a single JSON object with these fields:\n' +
		'  "root_cause": short description of the failure,\n' +
		'  "file": exact filename that must be edited,\n' +
		'  "variable": exact variable name that must be changed,\n' +
		'  "fix_action": what to do (e.g. append a value to a list),\n' +
		'  "new_value": the updated value after the fix.\n\n' +
		'Respond with ONLY the JSON object. No markdown, no explanation, no repetition.\n'
	);
}

// ─── Tool registry ───────────────────────────────────────

export interface ToolEnv {
	DISTIL_MODEL: string;
}

export interface SlmTool {
	/** Stable identifier surfaced on the incident so you can see which tool ran. */
	id: string;
	description: string;
	/** Which fine-tuned SLM the control plane calls for this failure mode. */
	model: (env: ToolEnv) => string;
	/** Routing: does this tool own the incident, judged by its crash-log signature? */
	matches: (crashLog: string) => boolean;
	/** Input contract — build the SLM prompt from the crash log. */
	buildPrompt: (crashLog: string) => string;
	/** Output contract — validate the structured response the orchestrator will act on. */
	validate: (value: unknown) => value is Diagnosis;
}

/**
 * The registered SLM tools. The harness scales by adding entries here.
 *
 * To support a new failure mode (dependency conflict, certificate expiry,
 * permission error, resource-limit breach), register another tool with its own
 * signature, model, prompt, and output contract. The control plane routes to it
 * automatically and Oz executes the same way — no change to the orchestrator.
 */
export const SLM_TOOLS: SlmTool[] = [
	{
		id: 'iot-schema-diagnosis',
		description: 'Diagnoses IoT gateway schema-mismatch failures (massive-iot-traces1).',
		model: (env) => env.DISTIL_MODEL,
		matches: (crashLog) => /SCHEMA_MISMATCH/i.test(crashLog),
		buildPrompt: buildIotSchemaPrompt,
		validate: isDiagnosis,
	},
];

/** Route a crash log to the SLM tool that owns its failure signature. */
export function selectTool(crashLog: string): SlmTool | null {
	return SLM_TOOLS.find((tool) => tool.matches(crashLog)) ?? null;
}
