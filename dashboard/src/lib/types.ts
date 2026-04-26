import demoContract from '../../../config/demo_contract.json';

export type DiagnosisValue =
	| string
	| number
	| boolean
	| null
	| DiagnosisValue[]
	| { [key: string]: DiagnosisValue };

export interface TelemetryPayload {
	device_id: string;
	temp: number;
	pressure: number;
	vibration_hz?: number;
	[key: string]: unknown;
}

export interface TelemetryEvent {
	id: string;
	timestamp: string;
	payload: TelemetryPayload;
	status: 'accepted' | 'rejected';
	error?: string;
}

export interface Diagnosis {
	root_cause: string;
	file: string;
	variable: string;
	fix_action: string;
	new_value: DiagnosisValue;
}

export type RemediationStatus = 'diagnosis_ready' | 'claimed' | 'running' | 'fixed' | 'failed' | 'cleared';

export interface RemediationEvent {
	id: string;
	timestamp: string;
	type: string;
	message: string;
	details?: DiagnosisValue;
}

export interface RemediationJob {
	id: string;
	status: RemediationStatus;
	created_at: string;
	updated_at: string;
	diagnosis: Diagnosis;
	target_file: string;
	target_variable: string;
	fix_action: string;
	new_value: DiagnosisValue;
	verify_command: string;
	expected_result: string;
	claimed_at?: string;
	completed_at?: string;
	completion_summary?: string;
	verification?: DiagnosisValue;
	events: RemediationEvent[];
}

export interface PipelineState {
	phase: 'idle' | 'sending' | 'validating' | 'crash_detected' | 'diagnosing' | 'diagnosis_ready' | 'awaiting_warp' | 'fixed';
	events: TelemetryEvent[];
	currentDiagnosis: Diagnosis | null;
	error: string | null;
}

export const APPROVED_FIELDS = demoContract.iot_gateway.approved_schema;

export const GOOD_PAYLOAD: TelemetryPayload = demoContract.payloads.good;

export const BAD_PAYLOAD: TelemetryPayload = demoContract.payloads.bad;
