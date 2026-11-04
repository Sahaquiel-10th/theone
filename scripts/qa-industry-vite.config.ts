/** Local-only entry for the real industry UI and the real main navigation. */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
function qaPort(name: string, fallback: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a localhost port from 1024 to 65535`);
  return value;
}
const apiPort = qaPort('ONE_INDUSTRY_QA_API_PORT', 3143), uiPort = qaPort('ONE_INDUSTRY_QA_UI_PORT', 5198);
export default defineConfig({
  // Production main.tsx owns history and the full-screen workbench route.
  // Vite must return the real index.html on a direct deep-link refresh.
  appType: 'spa',
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: uiPort, strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, ws: false } },
  },
});
