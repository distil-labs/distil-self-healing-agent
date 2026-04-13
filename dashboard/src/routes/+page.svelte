<script lang="ts">
	import type { TelemetryEvent, Diagnosis } from '$lib/types';
	import { BAD_PAYLOAD, GOOD_PAYLOAD } from '$lib/types';
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
	let errorLog = $state<string | null>(null);
	let warpPolling = $state(false);

	function addEvent(evt: TelemetryEvent) {
		events = [evt, ...events];
	}

	async function sendTelemetry(bad: boolean) {
		phase = 'sending';
		errorLog = null;
		diagnosis = null;

		const payload = bad ? BAD_PAYLOAD : GOOD_PAYLOAD;

		await sleep(400);
		phase = 'validating';

		const res = await fetch(`${WORKER_URL}/api/telemetry`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});

		const data = await res.json();

		const evt: TelemetryEvent = {
			id: crypto.randomUUID(),
			timestamp: data.timestamp,
			payload,
			status: data.status,
			error: data.error,
		};
		addEvent(evt);

		if (data.status === 'rejected') {
			phase = 'crash_detected';
			errorLog = data.crash_log;

			await sleep(1200);
			phase = 'diagnosing';

			const diagRes = await fetch(`${WORKER_URL}/api/diagnose`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ crash_log: data.crash_log }),
			});

			const diagData = await diagRes.json();
			diagnosis = diagData.diagnosis;
			phase = 'diagnosis_ready';

			// Store diagnosis for Warp Oz polling
			await fetch(`${WORKER_URL}/api/diagnosis`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ diagnosis }),
			});

			phase = 'awaiting_warp';
		} else {
			phase = 'fixed';
			await sleep(2000);
			phase = 'idle';
		}
	}

	function sleep(ms: number) {
		return new Promise((r) => setTimeout(r, ms));
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
						<div><span class="text-gray-500">new_value:</span> <span class="text-emerald-300">{diagnosis.new_value}</span></div>
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
							Diagnosis published. Waiting for Warp Oz to poll...
						</div>
						<p class="text-xs text-gray-600">
							Warp Oz polls <code class="text-gray-400">GET /api/diagnosis</code> to pick up the structured diagnosis, then applies the fix autonomously.
						</p>
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
