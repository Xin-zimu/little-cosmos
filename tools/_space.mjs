import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/').replace(/ /g, '%20');
const port = 9900 + Math.floor(Math.random() * 90);
const userDir = path.join(root, '_edge', 'profile');
fs.mkdirSync(userDir, { recursive: true }); fs.rmSync(path.join(userDir, 'lockfile'), { force: true });
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu-sandbox',
  '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files', '--no-first-run',
  '--window-size=1600,900', `--user-data-dir=${userDir}`], { stdio: 'ignore', windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = []; let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pending.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
const evalJS = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, timeout: 120000 }); if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text }; return r.result?.value; };
try {
  let ver = null;
  for (let i = 0; i < 120 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); } }
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } else if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200)); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url }); await sleep(14000);
  await evalJS("localStorage.clear()"); await evalJS("document.getElementById('btn-start').click()");
  let mode = null;
  for (let i = 0; i < 60; i++) { mode = await evalJS("window.__LC__ && window.__LC__.mode"); if (mode === 'surface') break; await sleep(1000); }
  await sleep(1500);

  // 进入太空阶段，用真实 updateSpace 逐帧推进，模拟平滑的鼠标转动
  const r = await evalJS(`(()=>{
    const g = window.__LC__;
    g.mode = 'space';
    g.flight.setPhase('space');
    g.flight.enterSpace(g.currentPlanetId);
    g.clock = { t: 0 };
    const V3 = g.player.pos.constructor;
    const base = { forward:0, strafe:0, mouseDX:0, mouseDY:0, wheel:0, held:new Set(), keys:new Set(), sprint:false };
    const turns = [];
    const ups = [];
    let prevDir = null;
    for (let i=0;i<45;i++){
      // 每帧鼠标横向移动 6px -> 平滑的偏航输入
      const inp = Object.assign({}, base, { mouseDX: 6, mouseDY: 0, held:new Set() });
      g.flight.updateSpace(1/60, inp);
      const dir = new V3(); g.camera.getWorldDirection(dir);
      const upNow = g.camera.up.clone();
      if (prevDir) turns.push(+(prevDir.angleTo(dir)*180/Math.PI).toFixed(3));
      prevDir = dir;
      if (i===0) ups.push(upNow.toArray().map(v=>+v.toFixed(3)));
    }
    const maxT = Math.max(...turns), minT = Math.min(...turns);
    const expected = 6*0.0022*180/Math.PI;
    return { expectedDeg:+expected.toFixed(3), maxTurn:maxT, minTurn:minT,
             meanTurn:+(turns.reduce((a,b)=>a+b,0)/turns.length).toFixed(3),
             maxOverExpected:+(maxT/expected).toFixed(1),
             firstCameraUp: ups[0],
             sampleTurns: turns.slice(0,8) };})()`);
  console.log('SPACE_CAM ' + JSON.stringify(r, null, 2));
  console.log('EXC ' + logs.length + (logs.length ? ' :: ' + logs.slice(0,3).join(' | ') : ' (none)'));
} catch (e) { console.error('ERR ' + e.message); }
finally { try { ws?.close(); } catch {} proc.kill(); await sleep(300); try { const { execSync } = await import('node:child_process'); execSync('taskkill /F /IM msedge.exe /T > NUL 2>&1'); } catch {} process.exit(0); }
