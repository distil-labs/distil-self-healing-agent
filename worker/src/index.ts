/**
 * Self-Healing Loop — Cloudflare Worker (Backend API)
 *
 * Standalone Worker handling:
 *   POST /api/telemetry      — Production telemetry ingest and diagnosis on reject
 *   POST /api/demo/telemetry — Operator-triggered demo event through the same pipeline
 *   POST /api/diagnose       — Direct crash-log diagnosis
 *   POST /api/remediation/next — Warp Oz claims the next durable job
 */

import demoContract from '../../config/demo_contract.json';

export interface Env {
	DISTIL_API_KEY: string;
	DISTIL_ENDPOINT: string;
	DISTIL_MODEL: string;
	INCIDENT_STORE: DurableObjectNamespace;
	WARP_API_KEY?: string;
	OZ_ENVIRONMENT_ID?: string;
	OZ_AGENT_API_URL?: string;
	OZ_AGENT_RUNS_API_URL?: string;
	OZ_AUTO_TRIGGER?: string;
	WORKER_PUBLIC_URL?: string;
	ALLOWED_ORIGIN?: string;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface Diagnosis {
	root_cause: string;
	file: string;
	variable: string;
	fix_action: string;
	new_value: JsonValue;
}

type IncidentStatus = 'diagnosis_ready' | 'claimed' | 'running' | 'fixed' | 'failed' | 'cleared';

interface RemediationEvent {
	id: string;
	timestamp: string;
	type: string;
	message: string;
	details?: JsonValue;
}

interface RemediationJob {
	id: string;
	status: IncidentStatus;
	created_at: string;
	updated_at: string;
	diagnosis: Diagnosis;
	target_file: string;
	target_variable: string;
	fix_action: string;
	new_value: JsonValue;
	verify_command: string;
	expected_result: string;
	crash_log?: string;
	prompt_length?: number;
	claimed_at?: string;
	completed_at?: string;
	completion_summary?: string;
	verification?: JsonValue;
	oz_run_id?: string;
	oz_run_state?: string;
	oz_session_link?: string;
	oz_status_message?: JsonValue;
	oz_run_details?: JsonValue;
	events: RemediationEvent[];
}

interface TelemetryValidationResult {
	status: 'accepted' | 'rejected';
	timestamp: string;
	payload: Record<string, unknown>;
	message?: string;
	error?: string;
	crash_log?: string;
}

interface DiagnosisRunResult {
	diagnosis: unknown;
	prompt_length: number;
	stored: boolean;
	timestamp: string | null;
	incident_id: string | null;
	job: RemediationJob | null;
	oz_trigger: unknown;
}

// ─── Constants ───────────────────────────────────────────
const GATEWAY_CONTRACT = demoContract.iot_gateway;
const DIAGNOSIS_CONTRACT = demoContract.diagnosis;
const APPROVED_FIELDS = GATEWAY_CONTRACT.approved_schema;
const MQTT_TOPIC = GATEWAY_CONTRACT.mqtt_topic;
const DEFAULT_OZ_AGENT_API_URL = 'https://app.warp.dev/api/v1/agent/run';
const DEFAULT_OZ_AGENT_RUNS_API_URL = 'https://app.warp.dev/api/v1/agent/runs';

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true;
	if (['string', 'number', 'boolean'].includes(typeof value)) return true;
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (isRecord(value)) return Object.values(value).every(isJsonValue);
	return false;
}

function isDiagnosis(value: unknown): value is Diagnosis {
	if (!isRecord(value)) return false;
	return (
		typeof value.root_cause === 'string' &&
		typeof value.file === 'string' &&
		typeof value.variable === 'string' &&
		typeof value.fix_action === 'string' &&
		isJsonValue(value.new_value)
	);
}

function createRemediationEvent(type: string, message: string, details?: JsonValue): RemediationEvent {
	return {
		id: crypto.randomUUID(),
		timestamp: new Date().toISOString(),
		type,
		message,
		details,
	};
}

function createRemediationJob(
	diagnosis: Diagnosis,
	options: { crash_log?: string; prompt_length?: number } = {}
): RemediationJob {
	const timestamp = new Date().toISOString();

	return {
		id: crypto.randomUUID(),
		status: 'diagnosis_ready',
		created_at: timestamp,
		updated_at: timestamp,
		diagnosis,
		target_file: diagnosis.file,
		target_variable: diagnosis.variable,
		fix_action: diagnosis.fix_action,
		new_value: diagnosis.new_value,
		verify_command: 'python3 iot-gateway/reproduce_crash.py',
		expected_result:
			"No CRITICAL SCHEMA_MISMATCH, exit code 0, and 'Payload validated successfully' in gateway logs.",
		crash_log: options.crash_log,
		prompt_length: options.prompt_length,
		events: [
			createRemediationEvent('diagnosis_completed', 'Structured diagnosis created and queued for Oz.'),
		],
	};
}

function incidentStore(env: Env): DurableObjectStub {
	const id = env.INCIDENT_STORE.idFromName('self-healing-loop');
	return env.INCIDENT_STORE.get(id);
}

function incidentStoreFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
	return incidentStore(env).fetch(`https://incident-store.local${path}`, init);
}

function buildOzPrompt(workerUrl: string): string {
	return `You are Warp Oz, acting as the remediation executor for the Distil self-healing demo.

Worker base URL: ${workerUrl}
Repository root: use the repository configured in this Oz cloud environment.

Protocol:
1. Claim the next durable remediation job:
   curl -s -X POST "${workerUrl}/api/remediation/next"
2. If the response status is "empty", report that no remediation job is available and stop.
3. If a job is returned, extract job.id, job.target_file, job.target_variable, job.new_value, and job.verify_command.
4. Emit a running event:
   curl -s -X POST "${workerUrl}/api/incidents/$JOB_ID/events" -H "Content-Type: application/json" -d '{"type":"oz_started","message":"Oz started remediation.","status":"running"}'
5. Apply the fix exactly:
   - Only edit job.target_file.
   - Treat job.target_variable as a dot-separated JSON path.
   - Set that JSON path to job.new_value.
   - Do not refactor or edit unrelated fields.
6. Emit a patch event to ${workerUrl}/api/incidents/$JOB_ID/events.
7. Run job.verify_command from the repository root.
8. If verification succeeds, POST {"status":"fixed","summary":"Verification passed after remediation."} to ${workerUrl}/api/incidents/$JOB_ID/complete.
9. If verification fails, POST {"status":"failed","summary":"Verification failed after remediation.","verification":{...}} to ${workerUrl}/api/incidents/$JOB_ID/complete.

Constraints:
- Do not use SDKs.
- Do not use Apache Iggy for this remediation loop.
- Do not change auth; this demo intentionally keeps the autonomy path open.
- Do not modify .env or log secrets.
- Do not make unrelated code changes.
- If the job targets anything outside the repository, mark the job failed.`;
}

function buildPrompt(crashLog: string): string {
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

function extractFirstJson(text: string): string {
	for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;

		for (let i = start; i < text.length; i += 1) {
			const char = text[i];

			if (inString) {
				if (escaped) {
					escaped = false;
				} else if (char === '\\') {
					escaped = true;
				} else if (char === '"') {
					inString = false;
				}
				continue;
			}

			if (char === '"') {
				inString = true;
			} else if (char === '{') {
				depth += 1;
			} else if (char === '}') {
				depth -= 1;
				if (depth === 0) {
					const candidate = text.slice(start, i + 1);
					try {
						const parsed = JSON.parse(candidate);
						return JSON.stringify(parsed, null, 2);
					} catch {
						break;
					}
				}
			}
		}
	}

	if (text.trim()) {
		try {
			const parsed = JSON.parse(text.trim());
			return JSON.stringify(parsed, null, 2);
		} catch {
			// fall through
		}
	}
	return text.trim();
}

// ─── Durable Incident State ──────────────────────────────

export class IncidentStore {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		try {
			if (path === '/diagnosis' && method === 'GET') {
				return json(await this.getDiagnosis());
			}
			if (path === '/diagnosis' && method === 'POST') {
				const body = await request.json() as { diagnosis?: unknown };
				if (!isDiagnosis(body.diagnosis)) {
					return json({ error: 'Invalid diagnosis payload' }, 400);
				}
				const job = await this.storeJob(createRemediationJob(body.diagnosis));
				return json({ status: 'stored', timestamp: job.created_at, incident_id: job.id, job });
			}
			if (path === '/diagnosis' && method === 'DELETE') {
				await this.clearLatest();
				return json({ status: 'cleared' });
			}
			if (path === '/jobs' && method === 'POST') {
				const body = await request.json() as {
					diagnosis?: unknown;
					crash_log?: string;
					prompt_length?: number;
				};
				if (!isDiagnosis(body.diagnosis)) {
					return json({ error: 'Invalid diagnosis payload' }, 400);
				}
				const job = await this.storeJob(createRemediationJob(body.diagnosis, {
					crash_log: body.crash_log,
					prompt_length: body.prompt_length,
				}));
				return json({ status: 'stored', timestamp: job.created_at, incident_id: job.id, job });
			}
			if (path === '/jobs/latest' && method === 'GET') {
				const job = await this.getLatestJob();
				return json(job ? { status: job.status, job } : { status: 'empty', job: null });
			}
			if (path === '/remediation/next' && method === 'POST') {
				return json(await this.claimNextJob());
			}

			const incidentMatch = path.match(/^\/incidents\/([^/]+)(?:\/(events|complete|oz-run))?$/);
			if (incidentMatch) {
				const [, incidentId, action] = incidentMatch;

				if (!action && method === 'GET') {
					const job = await this.getJob(incidentId);
					return job ? json({ status: job.status, job }) : json({ error: 'Incident not found' }, 404);
				}
				if (action === 'events' && method === 'POST') {
					const body = await request.json() as {
						type?: string;
						message?: string;
						details?: JsonValue;
						status?: IncidentStatus;
					};
					const job = await this.appendEvent(
						incidentId,
						body.type || 'oz_event',
						body.message || 'Oz emitted an event.',
						body.details,
						body.status
					);
					return job ? json({ status: job.status, job }) : json({ error: 'Incident not found' }, 404);
				}
				if (action === 'complete' && method === 'POST') {
					const body = await request.json() as {
						status?: 'fixed' | 'failed';
						summary?: string;
						verification?: JsonValue;
					};
					if (body.status !== 'fixed' && body.status !== 'failed') {
						return json({ error: 'status must be fixed or failed' }, 400);
					}
					const job = await this.completeJob(incidentId, body.status, body.summary, body.verification);
					return job ? json({ status: job.status, job }) : json({ error: 'Incident not found' }, 404);
				}
				if (action === 'oz-run' && method === 'POST') {
					const body = await request.json() as {
						run_id?: string;
						state?: string;
						session_link?: string;
						status_message?: JsonValue;
						details?: JsonValue;
					};
					if (!body.run_id) {
						return json({ error: 'Missing run_id' }, 400);
					}
					const job = await this.recordOzRun(
						incidentId,
						body.run_id,
						body.state,
						body.session_link,
						body.status_message,
						body.details
					);
					return job ? json({ status: job.status, job }) : json({ error: 'Incident not found' }, 404);
				}
			}

			return json({ error: 'Not found' }, 404);
		} catch (err) {
			return json({ error: 'Incident store error', details: String(err) }, 500);
		}
	}

	private async getJob(id: string): Promise<RemediationJob | null> {
		return await this.state.storage.get<RemediationJob>(`job:${id}`) ?? null;
	}

	private async getLatestJob(): Promise<RemediationJob | null> {
		const latestId = await this.state.storage.get<string>('latestJobId');
		return latestId ? await this.getJob(latestId) : null;
	}

	private async storeJob(job: RemediationJob): Promise<RemediationJob> {
		await this.state.storage.put(`job:${job.id}`, job);
		await this.state.storage.put('latestJobId', job.id);
		return job;
	}

	private async updateJob(job: RemediationJob): Promise<RemediationJob> {
		job.updated_at = new Date().toISOString();
		await this.state.storage.put(`job:${job.id}`, job);
		return job;
	}

	private async getDiagnosis(): Promise<unknown> {
		const job = await this.getLatestJob();
		if (!job || job.status === 'cleared') {
			return { status: 'no_diagnosis', diagnosis: null };
		}
		return {
			status: job.status === 'diagnosis_ready' ? 'ready' : job.status,
			diagnosis: job.diagnosis,
			timestamp: job.created_at,
			incident_id: job.id,
			job,
		};
	}

	private async clearLatest(): Promise<void> {
		const job = await this.getLatestJob();
		if (!job) return;
		job.status = 'cleared';
		job.events.push(createRemediationEvent('diagnosis_cleared', 'Latest diagnosis cleared from polling handoff.'));
		await this.updateJob(job);
		await this.state.storage.delete('latestJobId');
	}

	private async claimNextJob(): Promise<unknown> {
		const job = await this.getLatestJob();
		if (!job || job.status !== 'diagnosis_ready') {
			return { status: 'empty', job: null };
		}

		job.status = 'claimed';
		job.claimed_at = new Date().toISOString();
		job.events.push(createRemediationEvent('oz_claimed', 'Warp Oz claimed the remediation job.'));
		await this.updateJob(job);

		return { status: 'claimed', incident_id: job.id, job };
	}

	private async appendEvent(
		id: string,
		type: string,
		message: string,
		details?: JsonValue,
		status?: IncidentStatus
	): Promise<RemediationJob | null> {
		const job = await this.getJob(id);
		if (!job) return null;
		if (status) job.status = status;
		job.events.push(createRemediationEvent(type, message, details));
		return await this.updateJob(job);
	}

	private async completeJob(
		id: string,
		status: 'fixed' | 'failed',
		summary = status === 'fixed' ? 'Remediation completed.' : 'Remediation failed.',
		verification?: JsonValue
	): Promise<RemediationJob | null> {
		const job = await this.getJob(id);
		if (!job) return null;

		job.status = status;
		job.completed_at = new Date().toISOString();
		job.completion_summary = summary;
		job.verification = verification;
		job.events.push(createRemediationEvent(`oz_${status}`, summary, verification));
		return await this.updateJob(job);
	}

	private async recordOzRun(
		id: string,
		runId: string,
		state?: string,
		sessionLink?: string,
		statusMessage?: JsonValue,
		details?: JsonValue
	): Promise<RemediationJob | null> {
		const job = await this.getJob(id);
		if (!job) return null;

		job.oz_run_id = runId;
		job.oz_run_state = state;
		job.oz_session_link = sessionLink;
		job.oz_status_message = statusMessage;
		job.oz_run_details = details;
		job.events.push(createRemediationEvent(
			'oz_run_updated',
			`Warp Oz run ${runId} ${state ? `is ${state}` : 'was recorded'}.`,
			{
				run_id: runId,
				state: state || null,
				session_link: sessionLink || null,
				status_message: statusMessage || null,
			}
		));
		return await this.updateJob(job);
	}
}

// ─── Route Handlers ──────────────────────────────────────

async function handleTelemetry(request: Request, env: Env): Promise<Response> {
	const payload = await request.json().catch(() => null);
	if (!isRecord(payload)) {
		return json({ error: 'Telemetry payload must be a JSON object' }, 400);
	}

	return processTelemetryPayload(payload, env, new URL(request.url).origin, 'production_ingest');
}

async function handleDemoTelemetry(request: Request, env: Env): Promise<Response> {
	const body = await request.json().catch(() => ({})) as { bad?: boolean };
	const payload = body.bad ? demoContract.payloads.bad : demoContract.payloads.good;
	return processTelemetryPayload(
		payload as Record<string, unknown>,
		env,
		new URL(request.url).origin,
		'dashboard_demo_trigger'
	);
}

async function processTelemetryPayload(
	payload: Record<string, unknown>,
	env: Env,
	requestOrigin: string,
	source: 'production_ingest' | 'dashboard_demo_trigger'
): Promise<Response> {
	const validation = validateTelemetryPayload(payload);
	const body: Record<string, unknown> = {
		...validation.result,
		source,
	};

	if (validation.result.status === 'rejected' && validation.result.crash_log) {
		const diagnosis = await diagnoseCrashLog(validation.result.crash_log, env, requestOrigin);
		if (diagnosis.ok) {
			body.diagnosis = diagnosis.data.diagnosis;
			body.prompt_length = diagnosis.data.prompt_length;
			body.stored = diagnosis.data.stored;
			body.incident_id = diagnosis.data.incident_id;
			body.job = diagnosis.data.job;
			body.oz_trigger = diagnosis.data.oz_trigger;
		} else {
			body.diagnosis_error = diagnosis.data;
		}
	}

	return json(body, validation.httpStatus);
}

function validateTelemetryPayload(payload: Record<string, unknown>): {
	httpStatus: number;
	result: TelemetryValidationResult;
} {
	const timestamp = new Date().toISOString();

	const unexpectedFields: string[] = [];
	for (const field of Object.keys(payload)) {
		if (!APPROVED_FIELDS.includes(field)) {
			unexpectedFields.push(field);
		}
	}

	if (unexpectedFields.length > 0) {
		const field = unexpectedFields[0];
		const errorLog = `[CRITICAL] SCHEMA_MISMATCH: Unexpected field '${field}' detected in MQTT topic '${MQTT_TOPIC}'`;

		return {
			httpStatus: 422,
			result: {
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
		};
	}

	return {
		httpStatus: 200,
		result: {
			status: 'accepted',
			timestamp,
			payload,
			message: `Payload validated successfully for topic '${MQTT_TOPIC}'`,
		},
	};
}

async function handleDiagnose(request: Request, env: Env): Promise<Response> {
	const { crash_log } = await request.json() as { crash_log?: string };

	if (!crash_log) {
		return json({ error: 'Missing crash_log in request body' }, 400);
	}

	const result = await diagnoseCrashLog(crash_log, env, new URL(request.url).origin);
	return json(result.data, result.status);
}

async function diagnoseCrashLog(
	crash_log: string,
	env: Env,
	requestOrigin: string
): Promise<
	| { ok: true; status: 200; data: DiagnosisRunResult }
	| { ok: false; status: number; data: Record<string, unknown> }
> {
	const prompt = buildPrompt(crash_log);

	try {
		const resp = await fetch(env.DISTIL_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env.DISTIL_API_KEY}`,
			},
			body: JSON.stringify({
				max_tokens: 250,
				model: env.DISTIL_MODEL,
				stream: false,
				temperature: 0,
				prompt,
			}),
		});

		if (!resp.ok) {
			const errText = await resp.text();
			return {
				ok: false,
				status: 502,
				data: { error: `SLM request failed: ${resp.status}`, details: errText },
			};
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

		let storedAt: string | null = null;
		let incidentId: string | null = null;
		let job: RemediationJob | null = null;
		let ozTrigger: unknown = null;
		if (isDiagnosis(diagnosis)) {
			const storeResp = await incidentStoreFetch(env, '/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ diagnosis, crash_log, prompt_length: prompt.length }),
			});
			if (storeResp.ok) {
				const stored = await storeResp.json() as {
					timestamp?: string;
					incident_id?: string;
					job?: RemediationJob;
				};
				storedAt = stored.timestamp || null;
				incidentId = stored.incident_id || null;
				job = stored.job || null;

				if (env.OZ_AUTO_TRIGGER === 'true' && incidentId) {
					ozTrigger = await triggerOzCloudRun(env, requestOrigin, incidentId);
				}
			}
		}

		return {
			ok: true,
			status: 200,
			data: {
				diagnosis,
				prompt_length: prompt.length,
				stored: storedAt !== null,
				timestamp: storedAt,
				incident_id: incidentId,
				job,
				oz_trigger: ozTrigger,
			},
		};
	} catch (err) {
		return {
			ok: false,
			status: 502,
			data: { error: 'Failed to reach SLM endpoint', details: String(err) },
		};
	}
}

async function handleDiagnosisGet(env: Env): Promise<Response> {
	return incidentStoreFetch(env, '/diagnosis');
}

async function handleDiagnosisPost(request: Request, env: Env): Promise<Response> {
	return incidentStoreFetch(env, '/diagnosis', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: await request.text(),
	});
}

async function handleDiagnosisDelete(env: Env): Promise<Response> {
	return incidentStoreFetch(env, '/diagnosis', { method: 'DELETE' });
}

async function handleIncidentCreate(request: Request, env: Env): Promise<Response> {
	return incidentStoreFetch(env, '/jobs', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: await request.text(),
	});
}

async function handleLatestIncident(env: Env): Promise<Response> {
	return incidentStoreFetch(env, '/jobs/latest');
}

async function handleRemediationNext(env: Env): Promise<Response> {
	return incidentStoreFetch(env, '/remediation/next', { method: 'POST' });
}

async function handleIncidentRequest(request: Request, env: Env, path: string): Promise<Response> {
	return incidentStoreFetch(env, path.replace('/api', ''), {
		method: request.method,
		headers: { 'Content-Type': 'application/json' },
		body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
	});
}

async function triggerOzCloudRun(
	env: Env,
	requestOrigin: string,
	incidentId?: string,
	workerUrlOverride?: string
): Promise<unknown> {
	if (!env.WARP_API_KEY) {
		return { status: 'not_configured', error: 'Missing WARP_API_KEY' };
	}
	if (!env.OZ_ENVIRONMENT_ID) {
		return { status: 'not_configured', error: 'Missing OZ_ENVIRONMENT_ID' };
	}

	const workerUrl = workerUrlOverride || env.WORKER_PUBLIC_URL || requestOrigin;
	const targetIncidentId = incidentId || await getLatestIncidentId(env);

	if (!targetIncidentId) {
		return { status: 'empty', error: 'No durable remediation job is available' };
	}

	const prompt = buildOzPrompt(workerUrl);
	const resp = await fetch(env.OZ_AGENT_API_URL || DEFAULT_OZ_AGENT_API_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.WARP_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			title: `Self-healing remediation ${targetIncidentId}`,
			prompt,
			config: {
				environment_id: env.OZ_ENVIRONMENT_ID,
			},
		}),
	});

	const raw = await resp.text();
	let ozRun: unknown;
	try {
		ozRun = JSON.parse(raw);
	} catch {
		ozRun = { raw };
	}

	if (!resp.ok) {
		return { status: 'failed', error: 'Oz Agent API request failed', status_code: resp.status, details: ozRun };
	}

	const runId = isRecord(ozRun) && typeof ozRun.run_id === 'string' ? ozRun.run_id : null;
	const runState = isRecord(ozRun) && typeof ozRun.state === 'string' ? ozRun.state : undefined;

	if (runId) {
		await incidentStoreFetch(env, `/incidents/${targetIncidentId}/oz-run`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				run_id: runId,
				state: runState,
				details: isJsonValue(ozRun) ? ozRun : { response: String(ozRun) },
			}),
		});
	}

	await incidentStoreFetch(env, `/incidents/${targetIncidentId}/events`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			type: 'oz_cloud_triggered',
			message: 'Oz cloud remediation run was triggered.',
			details: isJsonValue(ozRun) ? ozRun : { response: String(ozRun) },
		}),
	});

	return { status: 'triggered', incident_id: targetIncidentId, oz_run: ozRun };
}

async function fetchOzRun(env: Env, runId: string): Promise<{ ok: boolean; status: number; data: unknown }> {
	if (!env.WARP_API_KEY) {
		return { ok: false, status: 400, data: { status: 'not_configured', error: 'Missing WARP_API_KEY' } };
	}

	const resp = await fetch(`${env.OZ_AGENT_RUNS_API_URL || DEFAULT_OZ_AGENT_RUNS_API_URL}/${encodeURIComponent(runId)}`, {
		headers: {
			Authorization: `Bearer ${env.WARP_API_KEY}`,
			Accept: 'application/json',
		},
	});
	const raw = await resp.text();
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		data = { raw };
	}

	return { ok: resp.ok, status: resp.status, data };
}

async function handleOzRunGet(env: Env, runId: string): Promise<Response> {
	const result = await fetchOzRun(env, runId);
	return json(result.data, result.ok ? 200 : result.status);
}

async function handleOzRunSync(request: Request, env: Env, incidentId: string): Promise<Response> {
	const body = request.method === 'POST'
		? await request.json().catch(() => ({})) as { run_id?: string }
		: {};
	let runId = body.run_id;

	if (!runId) {
		const incidentResp = await incidentStoreFetch(env, `/incidents/${incidentId}`);
		if (!incidentResp.ok) return incidentResp;
		const incident = await incidentResp.json() as { job?: RemediationJob };
		runId = incident.job?.oz_run_id;
	}

	if (!runId) {
		return json({ error: 'No Oz run_id recorded for incident' }, 404);
	}

	const result = await fetchOzRun(env, runId);
	if (!result.ok) {
		return json(result.data, result.status);
	}

	const details = result.data;
	const state = isRecord(details) && typeof details.state === 'string' ? details.state : undefined;
	const sessionLink = isRecord(details) && typeof details.session_link === 'string' ? details.session_link : undefined;
	const statusMessage = isRecord(details) && isJsonValue(details.status_message) ? details.status_message : undefined;

	const updateResp = await incidentStoreFetch(env, `/incidents/${incidentId}/oz-run`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			run_id: runId,
			state,
			session_link: sessionLink,
			status_message: statusMessage,
			details: isJsonValue(details) ? details : { response: String(details) },
		}),
	});

	const update = await updateResp.json();
	return json({ status: 'synced', oz_run: details, incident: update }, updateResp.ok ? 200 : updateResp.status);
}

async function getLatestIncidentId(env: Env): Promise<string | null> {
	const latestResp = await incidentStoreFetch(env, '/jobs/latest');
	if (!latestResp.ok) return null;
	const latest = await latestResp.json() as { job?: { id?: string } | null };
	return latest.job?.id || null;
}

async function handleOzTrigger(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const body = request.method === 'POST'
		? await request.json().catch(() => ({})) as { incident_id?: string; worker_url?: string }
		: {};
	const result = await triggerOzCloudRun(env, url.origin, body.incident_id, body.worker_url);
	const failed = isRecord(result) && result.status === 'failed';
	const notConfigured = isRecord(result) && result.status === 'not_configured';
	const empty = isRecord(result) && result.status === 'empty';
	return json(result, failed ? 502 : notConfigured ? 400 : empty ? 404 : 200);
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
				response = await handleTelemetry(request, env);
			} else if (path === '/api/demo/telemetry' && method === 'POST') {
				response = await handleDemoTelemetry(request, env);
			} else if (path === '/api/diagnose' && method === 'POST') {
				response = await handleDiagnose(request, env);
			} else if (path === '/api/diagnosis' && method === 'GET') {
				response = await handleDiagnosisGet(env);
			} else if (path === '/api/diagnosis' && method === 'POST') {
				response = await handleDiagnosisPost(request, env);
			} else if (path === '/api/diagnosis' && method === 'DELETE') {
				response = await handleDiagnosisDelete(env);
			} else if (path === '/api/incidents' && method === 'POST') {
				response = await handleIncidentCreate(request, env);
			} else if (path === '/api/incidents/latest' && method === 'GET') {
				response = await handleLatestIncident(env);
			} else if (path === '/api/remediation/next' && method === 'POST') {
				response = await handleRemediationNext(env);
			} else if (path === '/api/oz/trigger' && method === 'POST') {
				response = await handleOzTrigger(request, env);
			} else if (path.match(/^\/api\/oz\/runs\/[^/]+$/) && method === 'GET') {
				response = await handleOzRunGet(env, path.split('/').pop() || '');
			} else if (path.match(/^\/api\/incidents\/[^/]+\/oz\/sync$/) && method === 'POST') {
				const incidentId = path.split('/')[3];
				response = await handleOzRunSync(request, env, incidentId);
			} else if (path.match(/^\/api\/incidents\/[^/]+(?:\/(?:events|complete))?$/)) {
				response = await handleIncidentRequest(request, env, path);
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
