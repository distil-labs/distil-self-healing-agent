/**
 * Self-Healing Loop — Cloudflare Worker (Backend API)
 *
 * Standalone Worker handling:
 *   POST /api/telemetry   — Validates IoT payload against APPROVED_SCHEMA
 *   POST /api/diagnose    — Sends crash log to Distil Labs SLM, returns diagnosis
 *   GET  /api/diagnosis   — Warp Oz polls for latest diagnosis
 *   POST /api/diagnosis   — Stores diagnosis (Warp Oz polls GET to retrieve)
 *   DELETE /api/diagnosis  — Clears diagnosis after Warp Oz consumes it
 */

export interface Env {
	DISTIL_API_KEY: string;
	DISTIL_ENDPOINT: string;
	DISTIL_MODEL: string;
	ALLOWED_ORIGIN?: string;
}

interface Diagnosis {
	root_cause: string;
	file: string;
	variable: string;
	fix_action: string;
	new_value: string;
}

// ─── State ───────────────────────────────────────────────
// In-memory for demo. In production, use Cloudflare KV or D1.
let latestDiagnosis: { diagnosis: Diagnosis; timestamp: string } | null = null;

// ─── Constants ───────────────────────────────────────────
const APPROVED_SCHEMA = ['device_id', 'temp', 'pressure'];
const MQTT_TOPIC = 'factory/v3/telemetry';

const CODEBASE_CONTEXT = `CODEBASE MANIFEST:
- File: industrial_gateway.py
  - Variable: APPROVED_SCHEMA = ["device_id", "temp", "pressure"]
  - Variable: MQTT_TOPIC = "factory/v3/telemetry"
  - Behavior: Validates incoming JSON. Logs CRITICAL SCHEMA_MISMATCH and exits 1
    if any payload field is not in APPROVED_SCHEMA.
- File: reproduce_crash.py
  - Sends test payload: {"device_id": "plc-conveyor-07", "temp": 81.3, "pressure": 1.02, "vibration_hz": 42.7}`;

// ─── Helpers ─────────────────────────────────────────────

function cors(response: Response, origin: string): Response {
	const headers = new Headers(response.headers);
	headers.set('Access-Control-Allow-Origin', origin);
	headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type');
	return new Response(response.body, { status: response.status, headers });
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function buildPrompt(crashLog: string): string {
	return (
		'You are an IoT infrastructure diagnostics engine.\n' +
		'You have access to the following codebase information:\n\n' +
		CODEBASE_CONTEXT +
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

function extractFirstJson(text: string): string {
	const match = text.match(/\{[^{}]*\}/s);
	if (match) {
		try {
			const parsed = JSON.parse(match[0]);
			return JSON.stringify(parsed, null, 2);
		} catch {
			// fall through
		}
	}
	return text.trim();
}

// ─── Route Handlers ──────────────────────────────────────

async function handleTelemetry(request: Request): Promise<Response> {
	const payload = await request.json() as Record<string, unknown>;
	const timestamp = new Date().toISOString();

	const unexpectedFields: string[] = [];
	for (const field of Object.keys(payload)) {
		if (!APPROVED_SCHEMA.includes(field)) {
			unexpectedFields.push(field);
		}
	}

	if (unexpectedFields.length > 0) {
		const field = unexpectedFields[0];
		const errorLog = `[CRITICAL] SCHEMA_MISMATCH: Unexpected field '${field}' detected in MQTT topic '${MQTT_TOPIC}'`;

		return json(
			{
				status: 'rejected',
				timestamp,
				payload,
				error: errorLog,
				crash_log: [
					`${timestamp} INFO Gateway received message on topic '${MQTT_TOPIC}'`,
					`${timestamp} CRITICAL SCHEMA_MISMATCH: Unexpected field '${field}' detected in MQTT topic '${MQTT_TOPIC}'`,
					`EXIT CODE: 1`,
				].join('\n'),
			},
			422
		);
	}

	return json({
		status: 'accepted',
		timestamp,
		payload,
		message: `Payload validated successfully for topic '${MQTT_TOPIC}'`,
	});
}

async function handleDiagnose(request: Request, env: Env): Promise<Response> {
	const { crash_log } = await request.json() as { crash_log?: string };

	if (!crash_log) {
		return json({ error: 'Missing crash_log in request body' }, 400);
	}

	const prompt = buildPrompt(crash_log);

	try {
		const resp = await fetch(env.DISTIL_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env.DISTIL_API_KEY}`,
			},
			body: JSON.stringify({
				max_tokens: '250',
				model: env.DISTIL_MODEL,
				stream: 'false',
				temperature: '0',
				prompt,
			}),
		});

		if (!resp.ok) {
			const errText = await resp.text();
			return json({ error: `SLM request failed: ${resp.status}`, details: errText }, 502);
		}

		const data = await resp.json() as { choices?: { text?: string }[] };
		let diagnosisText = '';

		if (data.choices && data.choices.length > 0) {
			diagnosisText = extractFirstJson(data.choices[0].text || '');
		} else {
			diagnosisText = JSON.stringify(data, null, 2);
		}

		let diagnosis;
		try {
			diagnosis = JSON.parse(diagnosisText);
		} catch {
			diagnosis = { raw: diagnosisText };
		}

		return json({ diagnosis, prompt_length: prompt.length });
	} catch (err) {
		return json({ error: 'Failed to reach SLM endpoint', details: String(err) }, 502);
	}
}

async function handleDiagnosisGet(): Promise<Response> {
	if (!latestDiagnosis) {
		return json({ status: 'no_diagnosis', diagnosis: null });
	}
	return json({ status: 'ready', ...latestDiagnosis });
}

async function handleDiagnosisPost(request: Request): Promise<Response> {
	const body = await request.json() as { diagnosis: Diagnosis };
	const timestamp = new Date().toISOString();

	latestDiagnosis = { diagnosis: body.diagnosis, timestamp };

	return json({ status: 'stored', timestamp });
}

async function handleDiagnosisDelete(): Promise<Response> {
	latestDiagnosis = null;
	return json({ status: 'cleared' });
}

// ─── Router ──────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		const origin = env.ALLOWED_ORIGIN || '*';

		// Handle CORS preflight
		if (method === 'OPTIONS') {
			return cors(new Response(null, { status: 204 }), origin);
		}

		let response: Response;

		try {
			if (path === '/api/telemetry' && method === 'POST') {
				response = await handleTelemetry(request);
			} else if (path === '/api/diagnose' && method === 'POST') {
				response = await handleDiagnose(request, env);
			} else if (path === '/api/diagnosis' && method === 'GET') {
				response = await handleDiagnosisGet();
			} else if (path === '/api/diagnosis' && method === 'POST') {
				response = await handleDiagnosisPost(request);
			} else if (path === '/api/diagnosis' && method === 'DELETE') {
				response = await handleDiagnosisDelete();
			} else if (path === '/health') {
				response = json({ status: 'ok', service: 'self-healing-api' });
			} else {
				response = json({ error: 'Not found' }, 404);
			}
		} catch (err) {
			response = json({ error: 'Internal server error', details: String(err) }, 500);
		}

		return cors(response, origin);
	},
} satisfies ExportedHandler<Env>;
