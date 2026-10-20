// 视图探测器：等待指定条件后截图（默认等待 __LC__ 且 mode==surface 且渲染若干帧）
// 用法: node tools/view.mjs <out.png> [--setup "js…"] [--wait 12000] [--after 1200] [--size 1600x900] [--mobile]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = path.resolve(args[0] || 'view.png');
let wait = 14000, after = 1500, width = 1600, height = 900, mobile = false;
const setups = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--wait') wait = +args[++i];
  else if (a === '--after') after = +args[++i];
  else if (a === '--size') { const [w, h] = args[++i].split('x').map(Number); width = w; height = h; }
  else if (a === '--mobile') mobile = true;
  else if (a === '--setup') setups.push(args[++i]);
  else if (a === '--eval') setups.push(args[++i]);
}
const url = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/').replace(/ /g, '%20');
const port = 9900 + Math.floor(Math.random() * 90);
const userDir = path.join(root, '_edge', 'profile');
fs.mkdirSync(userDir, { recursive: true });
fs.rmSync(path.join(userDir, 'lockfile'), { force: true });
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, '--disable-crash-reporter', '--disable-breakpad',
  '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files',
  '--no-first-run', `--window-size=${width},${height}`, `--user-data-dir=${userDir}`,
], { stdio: 'ignore', windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const k = ++id; pending.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method, params })); });
let code = 0;
try {
  let ver = null;
  for (let i = 0; i < 120 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); } }
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 700));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 700));
    else if (m.method === 'Log.entryAdded') logs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`.slice(0, 500));
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  if (mobile) { await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); }
  await send('Page.navigate', { url });
  await sleep(wait);
  for (const s of setups) {
    const r = await send('Runtime.evaluate', { expression: s, awaitPromise: true, returnByValue: true, timeout: 120000 });
    console.log('SETUP => ' + JSON.stringify(r.result?.value ?? r.result?.description ?? r.exceptionDetails?.text));
  }
  await sleep(after);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('SHOT ' + out);
} catch (e) {
  console.error('ERR ' + e.message);
  code = 1;
} finally {
  console.log(`--- console (${logs.length}) ---`);
  const seen = new Set();
  for (const l of logs) {
    const key = l.slice(0, 140);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(l);
    if (seen.size > 30) break;
  }
  try { ws?.close(); } catch {}
  proc.kill();
  await sleep(300);
  try { const { execSync } = await import('node:child_process'); execSync('taskkill /F /IM msedge.exe /T > NUL 2>&1'); } catch {}
  process.exit(code);
}
