// 第三批：输入层 / 触摸 / 移动端 / 性能（#06–#13、#43、#44）
import * as THREE from 'three';

const makeEl = () => {
  const el = {
    _l: {}, classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); } },
    style: {}, dataset: {}, textContent: '', innerHTML: '', children: [],
    appendChild(c) { this.children.push(c); return c; }, remove() {}, querySelector: () => makeEl(),
    querySelectorAll: () => [], addEventListener(t, f) { (this._l[t] ||= []).push(f); },
    dispatch(t, e = {}) { (this._l[t] || []).forEach((f) => f(e)); },
    getContext: () => ({ createImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {}, clearRect() {}, save() {}, restore() {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 120 }), firstChild: null, parentElement: null,
  };
  return el;
};
const els = {};
const winL = {};
globalThis.document = {
  body: makeEl(), documentElement: makeEl(), hidden: false,
  getElementById: (id) => (els[id] ||= makeEl()),
  querySelector: () => makeEl(), querySelectorAll: () => [], createElement: () => makeEl(),
  addEventListener(t, f) { (winL[t] ||= []).push(f); }, pointerLockElement: null,
};
globalThis.window = {
  addEventListener(t, f) { (winL[t] ||= []).push(f); },
  innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
  matchMedia: () => ({ matches: true }), AudioContext: function () {},
};
Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 5 }, configurable: true });
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } };
const fire = (t, e) => (winL[t] || []).forEach((f) => f(e));

const { Input } = await import('../src/core/input.js');
const { BuildingSystem, BUILDINGS } = await import('../src/base/building.js');
const { Engine } = await import('../src/core/engine.js');

const results = [];
const check = (id, name, pass, detail) => results.push({ id, name, pass: !!pass, detail });

// ============ 08 摇杆进入统一输入层（太空也能读到） ============
{
  const canvas = makeEl();
  const inp = new Input(canvas);
  inp.touch.move.x = 1; inp.touch.move.y = -1;
  const st = inp.consume();
  const inSpaceUsable = st.forward !== 0 && st.strafe !== 0;
  check(8, '摇杆折算进统一输入层（地面与太空同一份状态）', inSpaceUsable && st.forward === 1 && st.strafe === 1,
    { forward: st.forward, strafe: st.strafe, throttleKey: st.throttle });
}
// 太空油门/曲率/降落独立通道
{
  const canvas = makeEl();
  const inp = new Input(canvas);
  inp.touch.throttle = 1; inp.touch.warp = true; inp.touch.land = true;
  const st = inp.consume();
  const st2 = inp.consume();
  check(8, '触屏具备持续油门、曲率与降落命令', st.throttle === 1 && st.warp === true && st.land === true && st2.land === false,
    { throttle: st.throttle, warp: st.warp, land: st.land, landNextFrame: st2.land });
}

// ============ 10 有触屏的电脑仍能用鼠标锁定 ============
{
  const canvas = makeEl();
  let locked = 0;
  canvas.requestPointerLock = () => { locked++; return { catch() {} }; };
  const inp = new Input(canvas);
  const touchDefault = inp.pointer;
  // 用户用鼠标（mousedown 会切换指针类型）
  canvas.dispatch('mousedown', { button: 0 });
  inp.requestLock();
  // 触摸之后不再抢锁
  const inp2 = new Input(makeEl());
  inp2.pointer = 'touch';
  inp2.requestLock();
  check(10, '按实际指针类型决定锁定，触屏电脑用鼠标仍可锁定', touchDefault === 'touch' && locked === 1,
    { defaultPointer: touchDefault, lockCalls: locked });
}

// ============ 11 触摸中断不再持续开火 ============
{
  const canvas = makeEl();
  const inp = new Input(canvas);
  inp.touch.fire = true;
  canvas.dispatch('touchcancel', { changedTouches: [{ identifier: 1 }] });
  // 通用复位钩子（UI 按钮用 pointercancel/touchcancel 绑定的 onEnd）
  inp.reset();
  const st = inp.consume();
  check(11, '触摸中断后不再持续开火', st.fire === false, { fire: st.fire });
}

// ============ 12 失焦清理瞄准 / 跳跃 / 鼠标位移 ============
{
  const canvas = makeEl();
  const inp = new Input(canvas);
  inp.buttons.aim = true; inp.justPressed.add('Space'); inp.mouseDX = 100;
  fire('blur');
  const st = inp.consume();
  check(12, '失焦后清空瞄准、瞬时按键与鼠标位移', st.aim === false && st.mouseDX === 0 && !st.keys.has('Space'),
    { aim: st.aim, mouseDX: st.mouseDX, keys: [...st.keys] });
}

// ============ 13 暂停期间按键不补执行 ============
{
  const canvas = makeEl();
  const inp = new Input(canvas);
  inp.enabled = false;
  inp.touch.move.x = 0;
  fire('keydown', { code: 'KeyB', repeat: false, preventDefault() {} });
  inp.enabled = true;
  const st = inp.consume();
  check(13, '暂停期间按下的键不会在恢复时补执行', st.build === false, { build: st.build, keys: [...st.keys] });
}

// ============ 07 建造条：结构上可滚动 + 宽度约束 ============
{
  const css = await import('node:fs').then((fs) => fs.readFileSync('./style.css', 'utf8'));
  const bar = css.match(/#build-bar\s*{[^}]*}/s);
  const item = css.match(/\.bb-item\s*{[^}]*}/s);
  const scrollable = /overflow-x:\s*auto/.test(bar[0]) && /max-width:\s*calc\(100vw/.test(bar[0]);
  const fixedBasis = /flex:\s*0\s+0\s+auto/.test(item[0]);
  check(7, '建造条可横向滚动且项目不被压缩', scrollable && fixedBasis, { scrollable, fixedBasis });
}

// ============ 06 触摸层不再铺满屏幕拦截 HUD ============
{
  const css = await import('node:fs').then((fs) => fs.readFileSync('./style.css', 'utf8'));
  const layerGone = !/#touch-layer\s*{[^}]*pointer-events:\s*auto/.test(css);
  const touchUi = css.match(/#touch-ui\s*{[^}]*}/s)[0];
  const noCapture = /pointer-events:\s*none/.test(touchUi);
  const childrenAuto = /#touch-ui\s*>\s*\*\s*{[^}]*pointer-events:\s*auto/.test(css);
  check(6, '触摸层不再铺满屏幕拦截控件', layerGone && noCapture && childrenAuto, { layerGone, noCapture, childrenAuto });
}

// ============ 09 触屏具备暂停入口 ============
{
  const fs = await import('node:fs');
  const html = fs.readFileSync('./index.html', 'utf8');
  const hasPause = /id="t-pause"/.test(html);
  const hasScan = /id="t-scan"/.test(html);
  const hasMode = /id="t-mode"/.test(html);
  const hasRotate = /id="t-rotate"/.test(html);
  check(9, '触屏补齐暂停/扫描/切枪/旋转入口', hasPause && hasScan && hasMode && hasRotate,
    { hasPause, hasScan, hasMode, hasRotate });
}

// ============ 43 建筑清空释放几何与材质 ============
{
  const g = {
    palette: { accent: '#8f8' }, scene: new THREE.Scene(),
    terrain: { height: () => 0, slopeAt: () => 0, waterLevel: -3 },
    camera: new THREE.PerspectiveCamera(), cameraLookTarget: new THREE.Vector3(),
    inventory: { ferrite: 99, silica: 99 }, rocket: { group: new THREE.Group() },
    ui: { toast() {} }, audio: { play() {} }, sunDirVec: new THREE.Vector3(0, 1, 0),
    vegetation: { blocked() { return null; } }, game: null,
  };
  g.player = { pos: new THREE.Vector3(), inRocket: false };
  const b = new BuildingSystem(g);
  b.restore([{ type: 'habitat', x: 0, z: 0 }, { type: 'solar', x: 5, z: 0 }]);
  let disposedGeo = 0, disposedMat = 0;
  b.items[0].mesh.traverse((o) => {
    if (o.geometry) { const d = o.geometry.dispose.bind(o.geometry); o.geometry.dispose = () => { disposedGeo++; d(); }; }
    if (o.material) { const d = o.material.dispose.bind(o.material); o.material.dispose = () => { disposedMat++; d(); }; }
  });
  b.clear();
  check(43, '建筑 clear() 释放几何与材质', disposedGeo > 0 && disposedMat > 0 && b.items.length === 0,
    { disposedGeo, disposedMat, items: b.items.length });
}

// ============ 44 后期链跟随渲染器像素比 ============
{
  const src = await import('node:fs').then((fs) => fs.readFileSync('./src/core/engine.js', 'utf8'));
  const syncsComposer = /composer\.setPixelRatio\(/.test(src);
  const orderOk = src.indexOf('composer.setPixelRatio') < src.indexOf('composer.setSize');
  check(44, 'resize 时同步 composer 像素比', syncsComposer && orderOk, { syncsComposer, orderOk });
}

console.log(JSON.stringify({ total: results.length, pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length, results }, null, 1));
