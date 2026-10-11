// Screenshot a page in headless Chrome/Edge (dev tool, no dependencies).
//   node tools/shot.mjs <url> <out.png> [--width 1400] [--height 900] [--wait 2000] [--full]
//                       [--eval "js run before the shot"]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--full') opt.full = true;
  else if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[++i];
}
const width = Number(opt.width ?? 1400);
const height = Number(opt.height ?? 900);
const browser = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
const port = 9800 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(tmpdir(), 'mousesim-shot-'));
const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', `--window-size=${width},${height}`, '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* starting */ }
  if (!wsUrl) await sleep(200);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + m.params.exceptionDetails.exception?.description);
  else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(Number(opt.wait ?? 2000));
  if (opt.eval) {
    const r = await send('Runtime.evaluate', { expression: opt.eval, awaitPromise: true, returnByValue: true });
    console.log('eval:', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description));
    await sleep(Number(opt.after ?? 500));
  }
  let clip;
  if (opt.full) {
    const m = await send('Page.getLayoutMetrics');
    const s = m.result.cssContentSize;
    clip = { x: 0, y: 0, width: s.width, height: Math.min(s.height, 16000), scale: 1 };
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!opt.full, ...(clip ? { clip } : {}) });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`saved ${out}`);
  if (logs.length) console.log(logs.join('\n'));
} finally {
  ws.close();
  proc.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
