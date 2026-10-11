// Copies onnxruntime-web's unbundled WebGPU build into public/ort/ (served at /ort/). It is loaded
// outside Vite's module graph on purpose: ORT's worker threads re-import its module, and a bundled
// chunk that shares helpers with the app would run the app inside every worker.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dst = join(root, 'public', 'ort');
mkdirSync(dst, { recursive: true });
for (const f of ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  const a = join(src, f);
  const b = join(dst, f);
  if (!existsSync(b) || statSync(b).size !== statSync(a).size) copyFileSync(a, b);
}
