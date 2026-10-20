// 探针测试：Node 内置 WebSocket 连接 Edge DevTools，截图 / 执行表达式 / 收集控制台
// 用法:
//   node tools/probe.mjs <url> <out.png> [--expr "..."]... [--wait 9000] [--size 1600x900] [--shots name:delayMS ...] [--mobile]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const url = args[0] || 'about:blank';
const out = path.resolve(args[1] || 'probe.png');
let wait = 9000;
let width = 1600, height = 900;
const exprs = [];
const shots = [];
const clicks = [];
let mobile = false;
const port = 9330 + Math.floor(Math.random() * 500);
for (let i = 2; i < args.length; i++) {
  const a = args[i];
  if (a === '--expr') exprs.push(args[++i]);
  else if (a === '--wait') wait = Number(args[++i]);
  else if (a === '--size') { const [w, h] = args[++i].split('x').map(Number); width = w; height = h; }
  else if (a === '--shots') shots.push(args[++i]);
  else if (a === '--click') clicks.push(args[++i]);
  else if (a === '--mobile') mobile = true;
}

const userDir = path.join(root, '_edge', 'profile');
fs.mkdirSync(userDir, { recursive: true });
fs.rmSync(path.join(userDir, 'lockfile'), { force: true });
const stdoutLog = path.join(root, '_edge', 'out.txt');
const stderrLog = path.join(root, '_edge', 'err.txt');
const edgeArgs = [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  '--disable-crash-reporter', '--disable-breakpad',
  '--disable-gpu-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  '--allow-file-access-from-files',
  '--no-first-run', '--window-size=' + width + ',' + height,
  '--user-data-dir=' + userDir,
];
const proc = spawn(EDGE, edgeArgs, { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(p, method = 'GET') {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method });
  return r.json();
}

async function waitForDevtools() {
  for (let i = 0; i < 120; i++) {
    try { return await getJSON('/json/version'); } catch { await sleep(250); }
  }
  throw new Error('devtools not reachable');
}

const consoleLogs = [];
let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const decodePng = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

async function shot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, decodePng(r.data));
  console.log('SHOT ' + file);
}

let exitCode = 0;
try {
  await waitForDevtools();
  const tab = await getJSON('/json/new?about:blank', 'PUT');
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      consoleLogs.push(`[${m.params.type}] ${text}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleLogs.push(`[EXCEPTION] ${d.text} ${d.exception?.description || ''}`);
    } else if (m.method === 'Log.entryAdded') {
      consoleLogs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`);
    }
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  if (mobile) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
  }
  await send('Page.navigate', { url });
  await sleep(wait);
  for (const e of exprs) {
    try {
      const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, timeout: 120000 });
      const v = r.result?.value ?? r.result?.description ?? r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text;
      console.log(`EXPR ${e.slice(0, 100)} => ${JSON.stringify(v)}`);
    } catch (err) {
      console.log(`EXPR FAILED ${e.slice(0, 100)}: ${err.message}`);
    }
  }
  for (const c of clicks) {
    const [x, y] = c.split(',').map(Number);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(500);
  }
  await shot(out);
  for (const s of shots) {
    const [name, delay] = s.split(':');
    await sleep(Number(delay || 1000));
    await shot(out.replace(/\.png$/, `_${name}.png`));
  }
} catch (e) {
  console.error('PROBE ERROR: ' + e.message);
  exitCode = 1;
} finally {
  console.log('--- console (' + consoleLogs.length + ') ---');
  for (const l of consoleLogs.slice(0, 100)) console.log(l.slice(0, 800));
  try { ws && ws.close(); } catch {}
  try { proc.kill(); } catch {}
  await sleep(400);
  try {
    const { execSync } = await import('node:child_process');
    execSync('taskkill /F /IM msedge.exe /T > NUL 2>&1', { windowsHide: true });
  } catch {}
  process.exit(exitCode);
}
