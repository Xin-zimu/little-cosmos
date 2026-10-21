import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/').replace(/ /g, '%20');
const port = 9900 + Math.floor(Math.random() * 90);
const userDir = path.join(root, '_edge', 'profile');
fs.mkdirSync(userDir, { recursive: true }); fs.rmSync(path.join(userDir, 'lockfile'), { force: true });
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu-sandbox', '--use-angle=swiftshader',
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
  // 进入太空
  await evalJS(`(()=>{const g=window.__LC__; g.mode='space'; g.flight.setPhase('space'); g.flight.enterSpace(g.currentPlanetId);
    g.ui.setSpaceHud(true); g.ui.setCockpit(false);})()`);
  await sleep(1500);
  // 极限俯仰：检查基向量是否仍正交、有无 NaN
  const r = await evalJS(`(()=>{const g=window.__LC__;const V3=g.player.pos.constructor;
    const out=[];
    for (const pitch of [-1.2,-0.6,0,0.6,1.2,1.5699]){
      g.flight.shipState.pitch = pitch;
      const base={forward:0,strafe:0,mouseDX:0,mouseDY:0,wheel:0,held:new Set(),keys:new Set()};
      g.flight.updateSpace(1/60, base);
      const d=new V3(); g.camera.getWorldDirection(d);
      const u=g.camera.up.clone();
      out.push({pitch, dirIsNaN:[d.x,d.y,d.z].some(Number.isNaN), upIsNaN:[u.x,u.y,u.z].some(Number.isNaN),
        'dir.dot(up)':+d.dot(u).toFixed(4), upLen:+u.length().toFixed(4),
        camPosIsNaN:[g.camera.position.x,g.camera.position.y,g.camera.position.z].some(Number.isNaN)});
    }
    g.flight.shipState.pitch = 0.1;
    return out;})()`);
  console.log('PITCH ' + JSON.stringify(r, null, 2));
  await sleep(1200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'screenshots', '15-space-cam.png'), Buffer.from(shot.data, 'base64'));
  console.log('EXC ' + logs.length + (logs.length ? ' :: ' + logs.slice(0,3).join(' | ') : ' (none)'));
} catch (e) { console.error('ERR ' + e.message); }
finally { try { ws?.close(); } catch {} proc.kill(); await sleep(300); try { const { execSync } = await import('node:child_process'); execSync('taskkill /F /IM msedge.exe /T > NUL 2>&1'); } catch {} process.exit(0); }
