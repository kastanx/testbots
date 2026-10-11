// End-to-end check of the recorder in headless Chrome/Edge (dev tool, no dependencies).
// Drives a dry-run session over CDP: moves the mouse along paths to each target, clicks it (with one
// deliberate miss), pauses and resumes with Space, ends with Esc, then prints what the server stored.
//
//   node tools/e2e_recorder.mjs --url http://localhost:8766 [--trials 12] [--browser path]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const base = args.url ?? 'http://localhost:8766';
const nTrials = Number(args.trials ?? 12);
const candidates = [
  args.browser,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const browserPath = candidates.find((p) => existsSync(p));
if (!browserPath) throw new Error('no Chrome or Edge found');

const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'mousesim-e2e-'));
const proc = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('browser did not start');
}

const ws = new WebSocket(await connect());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    listeners.forEach((l) => l(msg));
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const consoleLines = [];
listeners.push((m) => {
  if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(m.params.args.map((a) => a.value).join(' '));
  if (m.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails.exception?.description));
});

let mouse = { x: 800, y: 450 };
async function moveTo(x, y, steps) {
  const sx = mouse.x;
  const sy = mouse.y;
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    const e = s * s * (3 - 2 * s);
    const px = sx + (x - sx) * e + Math.sin(Math.PI * s) * 12;
    const py = sy + (y - sy) * e;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 });
  }
  mouse = { x, y };
}
async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60 + Math.random() * 60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
async function key(code, keyName, vk) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk });
}
const findTarget = () => evaluate(`(() => {
  const c = document.getElementById('stage'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4] > 150) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  const r = devicePixelRatio;
  return x1 < 0 ? null : { cx: (x0 + x1) / 2 / r, cy: (y0 + y1) / 2 / r, w: (x1 - x0 + 1) / r, h: (y1 - y0 + 1) / r };
})()`);

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `${base}/recorder/` });
  await sleep(1500);
  await evaluate(`document.getElementById('dryrun').checked = true; document.getElementById('start').click(); true`);
  await sleep(2500);
  const intro = await evaluate(`document.getElementById('overlay').innerText`);
  console.log('intro overlay:', JSON.stringify(intro.slice(0, 60)));
  await moveTo(800, 450, 20);
  await click(800, 450);
  let done = 0;
  let misses = 0;
  while (done < nTrials) {
    let t = null;
    for (let i = 0; i < 40 && !t; i++) {
      await sleep(50);
      t = await findTarget();
    }
    if (!t) throw new Error(`no target appeared (trial ${done})`);
    await sleep(150 + Math.random() * 150); // "reaction time"
    if (done === 3) {
      // Deliberate miss: stop short of the target, click, then correct.
      const ax = t.cx - (t.cx - mouse.x) * 0.15 - Math.sign(t.cx - mouse.x) * (t.w / 2 + 25);
      await moveTo(ax, t.cy + 0, 40);
      await click(ax, t.cy);
      misses++;
      await sleep(150);
    }
    await moveTo(t.cx + (Math.random() - 0.5) * t.w * 0.3, t.cy + (Math.random() - 0.5) * t.h * 0.3, 60);
    await sleep(80);
    await click(mouse.x, mouse.y);
    done++;
    if (done === 6) {
      await sleep(300);
      await key('Space', ' ', 32);
      await sleep(400);
      const paused = await evaluate(`document.getElementById('overlay').innerText`);
      console.log('paused overlay:', JSON.stringify(paused));
      await key('Space', ' ', 32);
    }
  }
  await sleep(300);
  await key('Escape', 'Escape', 27);
  await sleep(2500);
  console.log('summary:', await evaluate(`document.getElementById('last-session').innerText`));
  const sessions = await (await fetch(`${base}/api/sessions?dryrun=true`)).json();
  console.log('latest session:', JSON.stringify(sessions[sessions.length - 1]));
  console.log(`drove ${done} trials with ${misses} deliberate miss(es)`);
} finally {
  if (consoleLines.length) console.log('page console:\n  ' + consoleLines.join('\n  '));
  ws.close();
  proc.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ }
}
