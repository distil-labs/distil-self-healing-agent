<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Self-Healing Loop — Distil + Warp</title>
</svelte:head>

<div class="min-h-screen bg-gray-950 text-gray-100">
	{@render children()}
</div>
