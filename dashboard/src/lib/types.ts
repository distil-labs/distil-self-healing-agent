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
	new_value: string;
}

export interface PipelineState {
	phase: 'idle' | 'sending' | 'validating' | 'crash_detected' | 'diagnosing' | 'diagnosis_ready' | 'awaiting_warp' | 'fixed';
	events: TelemetryEvent[];
	currentDiagnosis: Diagnosis | null;
	error: string | null;
}

export const APPROVED_SCHEMA = ['device_id', 'temp', 'pressure'];

export const GOOD_PAYLOAD: TelemetryPayload = {
	device_id: 'plc-conveyor-07',
	temp: 81.3,
	pressure: 1.02,
};

export const BAD_PAYLOAD: TelemetryPayload = {
	device_id: 'plc-conveyor-07',
	temp: 81.3,
	pressure: 1.02,
	vibration_hz: 42.7,
};
