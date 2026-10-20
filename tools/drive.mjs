// 游戏驱动器：真实输入注入（鼠标/键盘/点击）+ 时间线动作 + 多截图
// 用法: node tools/drive.mjs <outPrefix> --script "actions-json"
// action: {t:ms, click:"#id"|null, key:"KeyW", down:true, up:true, tap:true, mouse:[dx,dy], shot:"name", eval:"js", wait:ms}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const prefix = path.resolve(args[0] || 'drive.png');
let script = [];
let width = 1600, height = 900, loadWait = 14000;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--script') script = JSON.parse(args[++i]);
  else if (args[i] === '--size') { const [w, h] = args[++i].split('x').map(Number); width = w; height = h; }
  else if (args[i] === '--load') loadWait = +args[++i];
}
const url = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/').replace(/ /g, '%20');
const port = 9800 + Math.floor(Math.random() * 150);
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
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
  return r.result?.value ?? r.result?.description ?? r.exceptionDetails?.text;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = prefix.replace(/\.png$/, `_${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('SHOT ' + file);
};
const clickSelector = async (sel) => {
  const box = await evalJS(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2];})()`);
  if (!box) { console.log('NO SELECTOR ' + sel); return; }
  const [x, y] = box;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
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
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 600));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 600));
    else if (m.method === 'Log.entryAdded') logs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`.slice(0, 400));
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  // --touch：模拟移动端（触摸事件 + 粗指针），用于验证虚拟摇杆与按钮
  const touchMode = args.includes('--touch');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touchMode });
  await send('Page.navigate', { url });
  await sleep(loadWait);
  let t = 0;
  for (const a of script) {
    const wait = a.wait || 0;
    if (wait) await sleep(wait);
    if (a.click) { await clickSelector(a.click); await sleep(a.after || 300); }
    if (a.key) {
      const base = { code: a.key, key: a.text || a.key.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: a.vk || 0 };
      if (a.tap !== false) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
        await sleep(a.hold || 60);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      }
    }
    if (a.down) await send('Input.dispatchKeyEvent', { type: 'keyDown', code: a.down, key: a.down.replace('Key', '').toLowerCase() });
    if (a.up) await send('Input.dispatchKeyEvent', { type: 'keyUp', code: a.up, key: a.up.replace('Key', '').toLowerCase() });
    if (a.mouse) {
      const [dx, dy] = a.mouse;
      const steps = 6;
      for (let s = 0; s < steps; s++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width / 2 + dx * (s + 1) / steps, y: height / 2 + dy * (s + 1) / steps, buttons: a.buttons || 0 });
        await sleep(16);
      }
    }
    if (a.mclick) {
      const [x, y] = [a.mclick[0] ?? width / 2, a.mclick[1] ?? height / 2];
      await send('Input.dispatchMouseEvent', { type: a.mclickType || 'mousePressed', x, y, button: a.button || 'left', clickCount: 1 });
      if ((a.mclickType || 'mousePressed') === 'mousePressed') await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: a.button || 'left', clickCount: 1 });
    }
    if (a.eval) console.log('EVAL => ' + JSON.stringify(await evalJS(a.eval)));
    if (a.shot) await shot(a.shot);
  }
  await shot('end');
} catch (e) {
  console.error('DRIVE ERR ' + e.message);
  code = 1;
} finally {
  console.log(`--- console (${logs.length}) ---`);
  const seen = new Set();
  for (const l of logs) { const k = l.slice(0, 120); if (seen.has(k)) continue; seen.add(k); console.log(l); if (seen.size > 25) break; }
  try { ws?.close(); } catch {}
  proc.kill();
  await sleep(300);
  try { const { execSync } = await import('node:child_process'); execSync('taskkill /F /IM msedge.exe /T > NUL 2>&1'); } catch {}
  process.exit(code);
}
