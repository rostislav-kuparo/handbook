import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Fixed port so the Tauri shell (src-tauri/tauri.conf.json → devUrl) can find it.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  worker: { format: 'es' },
  // Desktop app loaded from disk: one big chunk is fine.
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
