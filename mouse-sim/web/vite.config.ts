import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const api = 'http://127.0.0.1:8765';

// Cross-origin isolation: 5 us timer resolution instead of 100 us, and threads for onnxruntime-web.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root,
  server: {
    port: 5173,
    strictPort: true,
    headers: isolation,
    fs: { allow: ['..'] },
    proxy: { '/api': api, '/bundle': api, '/reports': api },
  },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: `${root}index.html`,
        recorder: `${root}recorder/index.html`,
        simulator: `${root}simulator/index.html`,
      },
    },
  },
});
