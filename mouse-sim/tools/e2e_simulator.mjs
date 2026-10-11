// End-to-end check of the simulator in headless Chrome/Edge (dev tool, no dependencies).
//   node tools/e2e_simulator.mjs --url http://localhost:8767 --out DIR [--width 1600 --height 900]
// Places targets with every model, shows variations, starts the blind test, takes screenshots and
// prints status lines and any page errors.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = {};
process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith('--')) args[a.slice(2)] = all[i + 1]; });
const base = args.url ?? 'http://localhost:8767';
const out = args.out ?? '.';
const width = Number(args.width ?? 1600);
const height = Number(args.height ?? 900);
mkdirSync(out, { recursive: true });
const browser = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
const port = 9500 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), 'mousesim-sim-'));
const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', `--window-size=${width},${height}`, '--enable-unsafe-webgpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ }
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
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, name), Buffer.from(r.result.data, 'base64'));
};
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};
const status = () => evaluate(`document.getElementById('status').innerText`);
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/simulator/` });
  for (let i = 0; i < 180; i++) { // the generative model may wait out a WebGPU timeout first
    await sleep(500);
    if (String(await status()).startsWith('Ready')) break;
  }
  console.log('status:', await status());
  const parity = await evaluate(`(async () => {
    const g = window.mouseSim?.gen;
    if (!g) return 'no generative model loaded';
    const r = await fetch('/bundle/gen/parity.json');
    if (!r.ok) return 'no gen/parity.json in the bundle';
    const fx = await r.json();
    const t0 = performance.now();
    const out = await g.sampleMovements(fx.conds, Float32Array.from(fx.noise));
    const ms = performance.now() - t0;
    let dt = 0, dl = 0, de = 0;
    out.forEach((m, b) => {
      fx.traj[b].forEach((p, i) => { dt = Math.max(dt, Math.abs(p[0] - m.traj[2 * i]), Math.abs(p[1] - m.traj[2 * i + 1])); });
      dl = Math.max(dl, Math.abs(fx.logdur[b] - m.logdur));
      de = Math.max(de, Math.abs(fx.end[b][0] - m.end[0]), Math.abs(fx.end[b][1] - m.end[1]));
    });
    return 'backend ' + g.backend + ': max |diff| path ' + dt.toExponential(2) + ', log duration ' + dl.toExponential(2) +
      ', end ' + de.toExponential(2) + ' (' + out.length + ' samples, ' + fx.steps + ' steps, ' + ms.toFixed(0) + ' ms)';
  })()`);
  console.log('generative parity:', parity);
  const models = await evaluate(`[...document.querySelectorAll('#model option')].map(o => o.value)`);
  console.log('models:', models.join(', '));
  const spots = [[900, 300], [600, 520], [1000, 580], [700, 250], [1100, 450], [520, 380], [820, 600]];
  let n = 0;
  for (const m of models) {
    await evaluate(`document.getElementById('model').value = ${JSON.stringify(m)}; true`);
    const [x, y] = spots[n++ % spots.length];
    const t0 = Date.now();
    await click(x, y);
    await sleep(m === 'generative' || m === 'hybrid' ? 2500 : 700);
    await shot(`sim_${m}_mid.png`);
    await sleep(2200);
    await shot(`sim_${m}_end.png`);
    console.log(`[${m}] ${(Date.now() - t0)} ms ->`, JSON.stringify(await status()));
  }
  await evaluate(`document.getElementById('model').value = 'motion_matching'; document.getElementById('opt-closest').checked = true; document.getElementById('opt-closest').dispatchEvent(new Event('change')); true`);
  await click(1000, 420);
  await sleep(300);
  await evaluate(`document.getElementById('btn-vars').click(); true`);
  await sleep(3500);
  await shot('sim_variations.png');
  console.log('[variations]', JSON.stringify(await status()));
  if (await evaluate(`!document.getElementById('btn-blind').disabled`)) {
    await evaluate(`document.getElementById('btn-blind').click(); true`);
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 40; k++) {
        await sleep(250);
        if (await evaluate(`!document.getElementById('blind-buttons').hidden`)) break;
      }
      if (i === 0) await shot('sim_blind_question.png');
      console.log('[blind]', JSON.stringify(await evaluate(`document.getElementById('blind-msg').innerText + ' | ' + document.getElementById('blind-progress').innerText`)));
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 });
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(800);
  }
  console.log(logs.length ? 'page errors:\n  ' + logs.join('\n  ') : 'no page errors');
} finally {
  ws.close();
  proc.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
