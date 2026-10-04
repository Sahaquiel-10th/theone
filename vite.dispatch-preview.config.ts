import { defineConfig } from 'vite';

// Explicit local-only entry: no backend proxy, no scan of unrelated fixture pages.
export default defineConfig({
 esbuild: { jsx: 'automatic' },
 cacheDir: 'node_modules/.vite-dispatch-preview',
 optimizeDeps: { entries: ['output/playwright/focus-preview.ts'], include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
 server: { host: '127.0.0.1', port: 4181, strictPort: true },
 build: { outDir: 'output/dispatch-preview-build', emptyOutDir: false, rollupOptions: { input: 'output/playwright/focus-preview.html' } }
});
