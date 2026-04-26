<script lang="ts">
	import type { TelemetryEvent, Diagnosis, RemediationJob } from '$lib/types';
	import { WORKER_URL } from '$lib/config';

	type Phase =
		| 'idle'
		| 'sending'
		| 'validating'
		| 'crash_detected'
		| 'diagnosing'
		| 'diagnosis_ready'
		| 'awaiting_warp'
		| 'fixed';

	let phase = $state<Phase>('idle');
	let events = $state<TelemetryEvent[]>([]);
	let diagnosis = $state<Diagnosis | null>(null);
	let currentJob = $state<RemediationJob | null>(null);
	let errorLog = $state<string | null>(null);
	let warpPolling = $state(false);
	let warpPollRun = 0;

	function addEvent(evt: TelemetryEvent) {
		events = [evt, ...events];
	}

	async function sendTelemetry(bad: boolean) {
		warpPollRun += 1;
		phase = 'sending';
		errorLog = null;
		diagnosis = null;
		currentJob = null;

		await sleep(400);
		phase = 'validating';

		const res = await fetch(`${WORKER_URL}/api/demo/telemetry`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bad }),
		});

		const data = await res.json();

		const evt: TelemetryEvent = {
			id: crypto.randomUUID(),
			timestamp: data.timestamp,
			payload: data.payload,
			status: data.status,
			error: data.error,
		};
		addEvent(evt);

		if (data.status === 'rejected') {
			phase = 'crash_detected';
			errorLog = data.crash_log;

			await sleep(1200);
			phase = 'diagnosing';

			if (data.diagnosis_error || !data.diagnosis) {
				const detail = data.diagnosis_error?.error ?? 'Worker did not return a diagnosis.';
				errorLog = `${data.crash_log}\n\nDiagnosis request failed: ${detail}`;
				phase = 'crash_detected';
				return;
			}

			diagnosis = data.diagnosis;
			currentJob = data.job ?? null;
			phase = 'diagnosis_ready';

			phase = 'awaiting_warp';
			warpPollRun += 1;
			void waitForWarpRemediation(warpPollRun, currentJob?.id ?? data.incident_id);
		} else {
			phase = 'fixed';
			await sleep(2000);
			phase = 'idle';
		}
	}

	async function waitForWarpRemediation(run: number, incidentId?: string) {
		warpPolling = true;

		for (let attempt = 0; attempt < 60; attempt += 1) {
			await sleep(3000);
			if (run !== warpPollRun || phase !== 'awaiting_warp') {
				warpPolling = false;
				return;
			}

			let data;
			try {
				const endpoint = incidentId
					? `${WORKER_URL}/api/incidents/${incidentId}`
					: `${WORKER_URL}/api/incidents/latest`;
				const res = await fetch(endpoint);
				data = await res.json();
			} catch {
				continue;
			}

			if (data.job) {
				currentJob = data.job;
			}

			if (data.status === 'fixed') {
				warpPolling = false;
				phase = 'fixed';
				await sleep(2000);
				if (run === warpPollRun) {
					phase = 'idle';
				}
				return;
			}

			if (data.status === 'failed') {
				warpPolling = false;
				errorLog = `${errorLog ?? ''}\n\nOz remediation failed: ${data.job?.completion_summary ?? 'No summary provided.'}`;
				phase = 'crash_detected';
				return;
			}

			if (data.status === 'cleared' || data.status === 'empty') {
				warpPolling = false;
				phase = 'idle';
				return;
			}
		}

		warpPolling = false;
	}

	async function resetDemo() {
		warpPollRun += 1;
		warpPolling = false;
		try {
			await fetch(`${WORKER_URL}/api/diagnosis`, { method: 'DELETE' });
		} catch {
			// Local demos should still be resettable if the Worker is not running.
		}
		phase = 'idle';
		diagnosis = null;
		currentJob = null;
		errorLog = null;
	}

	function sleep(ms: number) {
		return new Promise((r) => setTimeout(r, ms));
	}

	function formatDiagnosisValue(value: Diagnosis['new_value']): string {
		if (value === null) return 'null';
		if (typeof value === 'object') return JSON.stringify(value, null, 2);
		return String(value);
	}

	function eventLabel(eventType: string): string {
		return eventType.replaceAll('_', ' ');
	}

	function phaseLabel(p: Phase): string {
		const labels: Record<Phase, string> = {
			idle: 'IDLE — Ready',
			sending: 'SENDING TELEMETRY...',
			validating: 'GATEWAY VALIDATING...',
			crash_detected: 'CRASH DETECTED',
			diagnosing: 'DIAGNOSING VIA DISTIL LABS SLM...',
			diagnosis_ready: 'DIAGNOSIS COMPLETE',
			awaiting_warp: 'AWAITING WARP OZ REMEDIATION',
			fixed: 'TELEMETRY ACCEPTED',
		};
		return labels[p];
	}

	function phaseColor(p: Phase): string {
		if (p === 'crash_detected') return 'text-red-400';
		if (p === 'diagnosing') return 'text-amber-400';
		if (p === 'diagnosis_ready' || p === 'awaiting_warp') return 'text-blue-400';
		if (p === 'fixed') return 'text-emerald-400';
		return 'text-gray-400';
	}

	function phaseBg(p: Phase): string {
		if (p === 'crash_detected') return 'border-red-500/40 bg-red-500/5';
		if (p === 'diagnosing') return 'border-amber-500/40 bg-amber-500/5';
		if (p === 'diagnosis_ready' || p === 'awaiting_warp') return 'border-blue-500/40 bg-blue-500/5';
		if (p === 'fixed') return 'border-emerald-500/40 bg-emerald-500/5';
		return 'border-gray-700 bg-gray-900';
	}
</script>

<div class="mx-auto max-w-6xl px-6 py-10">
	<!-- Header -->
	<header class="mb-10">
		<h1 class="text-3xl font-bold tracking-tight">
			<span class="text-emerald-400">Self-Healing</span> Infrastructure Loop
		</h1>
		<p class="mt-2 text-sm text-gray-500">
			Distil Labs SLM (Brain) + Warp Oz (Hands) — Autonomous Remediation Demo
		</p>
	</header>

	<!-- Pipeline Status -->
	<div class="mb-8 rounded-lg border {phaseBg(phase)} p-5 transition-all duration-500">
		<div class="flex items-center gap-3">
			{#if phase === 'diagnosing' || phase === 'sending' || phase === 'validating'}
				<div class="h-3 w-3 animate-pulse rounded-full bg-amber-400"></div>
			{:else if phase === 'crash_detected'}
				<div class="h-3 w-3 rounded-full bg-red-400"></div>
			{:else if phase === 'fixed'}
				<div class="h-3 w-3 rounded-full bg-emerald-400"></div>
			{:else if phase === 'awaiting_warp'}
				<div class="h-3 w-3 animate-pulse rounded-full bg-blue-400"></div>
			{:else}
				<div class="h-3 w-3 rounded-full bg-gray-600"></div>
			{/if}
			<span class="font-mono text-sm font-semibold uppercase {phaseColor(phase)}">
				{phaseLabel(phase)}
			</span>
		</div>
	</div>

	<!-- Action Buttons -->
	<div class="mb-8 flex gap-4">
		<button
			onclick={() => sendTelemetry(true)}
			disabled={phase !== 'idle' && phase !== 'awaiting_warp'}
			class="rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
		>
			Send Bad Telemetry (vibration_hz)
		</button>
		<button
			onclick={() => sendTelemetry(false)}
			disabled={phase !== 'idle' && phase !== 'awaiting_warp'}
			class="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
		>
			Send Good Telemetry
		</button>
		{#if phase !== 'idle'}
			<button
				onclick={resetDemo}
				class="rounded-lg border border-gray-700 px-5 py-2.5 text-sm font-semibold text-gray-200 transition hover:border-gray-500 hover:bg-gray-900"
			>
				Reset Demo
			</button>
		{/if}
	</div>

	<!-- Two-column layout -->
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<!-- Left: Crash Log & Diagnosis -->
		<div class="space-y-6">
			<!-- Crash Log -->
			<section class="rounded-lg border border-gray-800 bg-gray-900 p-5">
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Crash Log</h2>
				{#if errorLog}
					<pre class="overflow-x-auto rounded bg-black/50 p-4 font-mono text-xs leading-relaxed text-red-300">{errorLog}</pre>
				{:else}
					<p class="text-sm text-gray-600">No crash detected yet.</p>
				{/if}
			</section>

			<!-- Diagnosis -->
			<section class="rounded-lg border border-gray-800 bg-gray-900 p-5">
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
					SLM Diagnosis
					<span class="ml-2 text-gray-700">(Distil Labs massive-iot-traces1)</span>
				</h2>
				{#if diagnosis}
					<div class="space-y-2 rounded bg-black/50 p-4 font-mono text-xs">
						<div><span class="text-gray-500">root_cause:</span> <span class="text-amber-300">{diagnosis.root_cause}</span></div>
						<div><span class="text-gray-500">file:</span> <span class="text-blue-300">{diagnosis.file}</span></div>
						<div><span class="text-gray-500">variable:</span> <span class="text-blue-300">{diagnosis.variable}</span></div>
						<div><span class="text-gray-500">fix_action:</span> <span class="text-emerald-300">{diagnosis.fix_action}</span></div>
						<div>
							<span class="text-gray-500">new_value:</span>
							<pre class="mt-1 whitespace-pre-wrap text-emerald-300">{formatDiagnosisValue(diagnosis.new_value)}</pre>
						</div>
					</div>
				{:else if phase === 'diagnosing'}
					<div class="flex items-center gap-2 text-sm text-amber-400">
						<div class="h-2 w-2 animate-pulse rounded-full bg-amber-400"></div>
						Querying Distil Labs SLM...
					</div>
				{:else}
					<p class="text-sm text-gray-600">No diagnosis yet.</p>
				{/if}
			</section>

			<!-- Warp Oz Status -->
			<section class="rounded-lg border border-gray-800 bg-gray-900 p-5">
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
					Warp Oz
					<span class="ml-2 text-gray-700">(Agentic CLI — Remediation)</span>
				</h2>
				{#if phase === 'awaiting_warp'}
					<div class="space-y-2">
						<div class="flex items-center gap-2 text-sm text-blue-400">
							<div class="h-2 w-2 animate-pulse rounded-full bg-blue-400"></div>
							{#if currentJob?.status === 'claimed'}
								Warp Oz claimed incident {currentJob.id}.
							{:else if currentJob?.status === 'running'}
								Warp Oz is applying the remediation.
							{:else}
								Diagnosis queued as incident {currentJob?.id ?? 'pending'}. {warpPolling ? 'Watching job state...' : 'Waiting for Warp Oz to claim...'}
							{/if}
						</div>
						<p class="text-xs text-gray-600">
							Warp Oz claims <code class="text-gray-400">POST /api/remediation/next</code>, emits events to <code class="text-gray-400">/api/incidents/:id/events</code>, then completes the job.
						</p>
						{#if currentJob?.events?.length}
							<div class="mt-3 space-y-2 border-t border-gray-800 pt-3">
								{#each currentJob.events as event (event.id)}
									<div class="font-mono text-xs">
										<div class="flex items-center justify-between gap-3">
											<span class="uppercase text-blue-300">{eventLabel(event.type)}</span>
											<span class="text-gray-700">{event.timestamp}</span>
										</div>
										<p class="mt-1 text-gray-500">{event.message}</p>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{:else if phase === 'fixed'}
					<div class="flex items-center gap-2 text-sm text-emerald-400">
						<div class="h-2 w-2 rounded-full bg-emerald-400"></div>
						Remediation complete.
					</div>
				{:else}
					<p class="text-sm text-gray-600">Standing by.</p>
				{/if}
			</section>
		</div>

		<!-- Right: Event Stream -->
		<section class="rounded-lg border border-gray-800 bg-gray-900 p-5">
			<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
				Telemetry Event Stream
			</h2>
			{#if events.length === 0}
				<p class="text-sm text-gray-600">No events yet. Send telemetry to begin.</p>
			{:else}
				<div class="space-y-3 max-h-[600px] overflow-y-auto pr-2">
					{#each events as evt (evt.id)}
						<div
							class="rounded-md border p-3 font-mono text-xs {evt.status === 'rejected'
								? 'border-red-800/50 bg-red-950/30'
								: 'border-emerald-800/50 bg-emerald-950/30'}"
						>
							<div class="mb-1 flex items-center justify-between">
								<span
									class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase {evt.status === 'rejected'
										? 'bg-red-900/60 text-red-300'
										: 'bg-emerald-900/60 text-emerald-300'}"
								>
									{evt.status}
								</span>
								<span class="text-gray-600">{evt.timestamp}</span>
							</div>
							<pre class="mt-1 text-gray-400">{JSON.stringify(evt.payload, null, 2)}</pre>
							{#if evt.error}
								<p class="mt-1 text-red-400">{evt.error}</p>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>
	</div>

	<!-- Architecture Footer -->
	<footer class="mt-12 border-t border-gray-800 pt-6 text-center text-xs text-gray-600">
		<p>
			<span class="text-gray-500">Observe</span> (dlt) →
			<span class="text-amber-500">Diagnose</span> (Distil Labs SLM) →
			<span class="text-blue-500">Fix</span> (Warp Oz) →
			<span class="text-emerald-500">Deploy</span> (CI/CD)
		</p>
		<p class="mt-1">Autonomous Self-Healing Software Loop</p>
	</footer>
</div>
