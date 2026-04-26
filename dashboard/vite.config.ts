import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const dashboardRoot = new URL('.', import.meta.url).pathname;
const repoRoot = new URL('..', import.meta.url).pathname;

export default defineConfig({
	server: {
		fs: {
			allow: [dashboardRoot, repoRoot]
		}
	},
	plugins: [tailwindcss(), sveltekit()]
});
