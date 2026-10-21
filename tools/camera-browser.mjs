// 使用独立的临时 Edge 配置回放三颗星球的起降；只关闭本脚本启动的浏览器。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(root, '_edge', `camera-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const proc = spawn(edge, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files',
  '--window-size=1280,800', `--user-data-dir=${profile}`], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, nextId = 0;
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async name => {
  await evaluate('__LC__.renderOnly()');
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'screenshots', `_camera-${name}.png`), Buffer.from(r.data, 'base64'));
};
try {
  const active = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(active); i++) await sleep(200);
  const port = fs.readFileSync(active, 'utf8').split('\n')[0];
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.description || a.value).join(' '));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'index.html')).href });
  for (let i = 0; i < 120; i++) {
    if (await evaluate('!!window.__LC__?.lastT')) break;
    await sleep(250);
  }
  await evaluate("document.getElementById('btn-start').click()");
  for (let i = 0; i < 120; i++) {
    if (await evaluate("__LC__.mode === 'surface'")) break;
    await sleep(250);
  }
  assert.equal(await evaluate('__LC__.mode'), 'surface');
  // 暂停真实时钟，按固定步长推进真实 Game.update；截图仍通过 WebGL 渲染。
  await evaluate(`window.g=__LC__; g.paused=true; g.setQuality('low');
    window.step=(n)=>{for(let i=0;i<n;i++){g.time+=1/60;g.update(1/60);
      if(![...g.camera.position.toArray(),...g.camera.quaternion.toArray()].every(Number.isFinite)) throw Error('invalid camera');}};
    window.until=(phase,max=900)=>{let n=0;while(g.flight.phase!==phase&&n++<max)step(1);
      if(g.flight.phase!==phase)throw Error('phase timeout: '+phase+' got '+g.flight.phase);};`);
  const results = [];
  for (const dest of ['emer', 'lumina', 'verdant']) {
    await evaluate(`g.flight.beginBoard();g.mode='board';until('cockpit');step(90);`);
    if (dest === 'emer') await shot('cockpit');
    await evaluate(`g.input.justPressed.add('KeyE');step(1);step(120);`);
    if (dest === 'emer') await shot('launch');
    await evaluate("until('space');step(1)");
    if (dest === 'emer') await shot('space');
    await evaluate(`g.flight.requestLanding('${dest}');step(120)`);
    if (dest === 'emer') await shot('approach');
    await evaluate("until('atmos')");
    const localDistance = await evaluate('g.camera.position.distanceTo(g.rocket.group.position)');
    assert.ok(localDistance < 30, `landing camera must already be in local coordinates, got ${localDistance}`);
    if (dest === 'emer') await shot('atmos');
    await evaluate("until('landing');step(180)");
    if (dest === 'emer') await shot('landing');
    await evaluate("until('exit');step(90)");
    if (dest === 'emer') await shot('exit');
    const result = await evaluate(`(()=>{until('ground');
      const before=g.camera.position.clone(), q=g.camera.quaternion.clone();step(1);
      return {planet:g.currentPlanetId,mode:g.mode,jump:g.camera.position.distanceTo(before),turn:q.angleTo(g.camera.quaternion),
        visible:g.player.object.visible, clearance:g.camera.position.y-g.terrain.height(g.camera.position.x,g.camera.position.z),
        shipGround:g.rocket.group.position.y-g.terrain.height(g.rocket.group.position.x,g.rocket.group.position.z)};})()`);
    assert.equal(result.planet, dest);
    assert.equal(result.mode, 'surface');
    assert.ok(result.visible);
    assert.ok(result.jump < 0.08, JSON.stringify(result));
    assert.ok(result.turn < 0.03, JSON.stringify(result));
    assert.ok(result.clearance > 0.3, JSON.stringify(result));
    assert.ok(Math.abs(result.shipGround) < 0.01, JSON.stringify(result));
    results.push(result);
    await shot(dest);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, trips: results, browserErrors: errors }, null, 2));
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id: ++nextId, method: 'Browser.close' }));
    ws.close();
  }
  proc.kill();
}
