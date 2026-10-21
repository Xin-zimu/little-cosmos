// 第四批：飞行检查点 / 任务进度 / 星球状态往返（#04、#48、#02）
import * as THREE from 'three';
const makeEl = () => ({
  _l: {}, classList: { _s: new Set(), add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {}, dataset: {}, textContent: '', innerHTML: '', children: [],
  appendChild(c) { this.children.push(c); return c; }, remove() {}, querySelector: () => makeEl(),
  querySelectorAll: () => [], addEventListener() {}, getContext: () => ({ createImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {}, clearRect() {}, save() {}, restore() {} }),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 120 }), firstChild: null, parentElement: null,
});
const els = {};
globalThis.document = { body: makeEl(), documentElement: makeEl(), hidden: false, getElementById: (id) => (els[id] ||= makeEl()), querySelector: () => makeEl(), querySelectorAll: () => [], createElement: () => makeEl(), addEventListener() {}, pointerLockElement: null };
globalThis.window = { addEventListener() {}, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, matchMedia: () => ({ matches: false }), AudioContext: function () {} };
Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true });
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };

const { Game } = await import('../src/main.js');
const { FlightSystem } = await import('../src/ship/flight.js');
const { UI } = await import('../src/ui/ui.js');

const results = [];
const check = (id, name, pass, detail) => results.push({ id, name, pass: !!pass, detail });

// ============ 48 自由探索时清空任务进度 ============
{
  const game = { palette: { accent: '#8f8', name: 'x', code: 'V-01', latin: 'V', gravity: 7.4 }, paletteMap: {}, inventory: {}, weapon: { energy: 100, maxEnergy: 100, mode: 0, modes: ['单发', '脉冲', '散射'] }, flight: { phase: 'ground', shipState: { pos: new THREE.Vector3() } }, spaceSystem: { planets: {} }, resources: { nodes: [] }, building: { items: [] }, ecosystem: { list: [] }, rocket: { group: new THREE.Group() }, player: { pos: new THREE.Vector3(), camYaw: 0 }, input: { touch: {}, resetHooks: [] }, audio: { setMusicVolume() {}, setSfxVolume() {} }, dialogueBusy: false, mode: 'surface' };
  const ui = new UI(game);
  ui.setObjective({ text: '采集', need: 5 });
  ui.updateObjectiveProgress(0, 5);
  ui.setObjective(null);
  const bar = els['obj-bar'];
  const count = els['obj-count'];
  check(48, '清空目标时隐藏进度并清零计数', bar.style.width === '0%' && count.textContent === '', { barWidth: bar.style.width, count: count.textContent });
}
// 设新目标时重置进度
{
  const game = { palette: { accent: '#8f8', name: 'x', code: 'V-01', latin: 'V', gravity: 7.4 }, paletteMap: {}, inventory: {}, weapon: { energy: 100, maxEnergy: 100, mode: 0, modes: ['单发', '脉冲', '散射'] }, flight: { phase: 'ground', shipState: { pos: new THREE.Vector3() } }, spaceSystem: { planets: {} }, resources: { nodes: [] }, building: { items: [] }, ecosystem: { list: [] }, rocket: { group: new THREE.Group() }, player: { pos: new THREE.Vector3(), camYaw: 0 }, input: { touch: {}, resetHooks: [] }, audio: { setMusicVolume() {}, setSfxVolume() {} }, dialogueBusy: false, mode: 'surface' };
  const ui = new UI(game);
  ui.setObjective({ text: 'A', need: 3 }); ui.updateObjectiveProgress(3, 3);
  ui.setObjective({ text: 'B', need: 7 });
  check(48, '设置新目标时进度归零', els['obj-count'].textContent === '0 / 7' && els['obj-bar'].style.width === '0%',
    { count: els['obj-count'].textContent, bar: els['obj-bar'].style.width });
}

// ============ 04 飞行检查点 ============
{
  const game = new Game(null);
  game.ui = { toast() {}, fadeTo() {}, setObjective() {}, dialogue() {}, showPrompt() {}, setBuildingMode() {}, updateObjectiveProgress() {}, setSpaceHud() {}, crosshairSpace() {}, setCockpit() {}, planetMarker() {} };
  game.audio = { play() {}, setEngine() {}, updateMusic() {}, updateAmbient() {}, setListener() {}, setPlanet() {} };
  game.player = { inRocket: true, object: { visible: true, position: new THREE.Vector3() }, pos: new THREE.Vector3() };
  game.camera = new THREE.PerspectiveCamera();
  game.rocket = { group: new THREE.Group(), throttle: 0.4, update() {}, openDoor() {} };
  game.spaceSystem = { setVisible() {}, follow() {} };
  game.terrain = { group: new THREE.Group(), height: () => 0 };
  game.vegetation = { group: new THREE.Group() };
  game.ecosystem = { group: new THREE.Group() };
  game.building = { group: new THREE.Group() };
  game.resources = { group: new THREE.Group() };
  game.motes = new THREE.Object3D(); game.water = null; game.dustPlume = new THREE.Object3D();
  game.currentPlanetId = 'verdant';
  game.mode = 'space';
  game.flight = new FlightSystem(game);
  game.flight.shipState.pos.set(123, 456, 789);
  game.flight.shipState.yaw = 1.1; game.flight.shipState.pitch = -0.3;
  game.flight.shipState.throttle = 0.62;
  game.flight.phase = 'space';
  const cp = game.captureFlightState();
  const ok = cp.kind === 'space' && cp.pos[0] === 123 && cp.throttle === 0.62;

  // 校验器接受该检查点
  const valid = game.validateSave({ version: 3, planet: 'verdant', flight: cp });
  const badPos = game.validateSave({ version: 3, planet: 'verdant', flight: { kind: 'space', planet: 'verdant', pos: [1, null, 3] } });
  const badKind = game.validateSave({ version: 3, planet: 'verdant', flight: { kind: 'warp' } });

  // 恢复到新实例
  const g2 = new Game(null);
  g2.ui = game.ui; g2.audio = game.audio;
  g2.player = { inRocket: false, object: { visible: true, position: new THREE.Vector3() }, pos: new THREE.Vector3() };
  g2.camera = new THREE.PerspectiveCamera();
  g2.rocket = { group: new THREE.Group(), throttle: 0, update() {}, openDoor() {} };
  g2.spaceSystem = { setVisible() {}, follow() {} };
  g2.terrain = { group: new THREE.Group(), height: () => 0 };
  g2.vegetation = { group: new THREE.Group() }; g2.ecosystem = { group: new THREE.Group() };
  g2.building = { group: new THREE.Group() }; g2.resources = { group: new THREE.Group() };
  g2.motes = new THREE.Object3D(); g2.dustPlume = new THREE.Object3D();
  g2.flight = new FlightSystem(g2);
  const restored = g2.restoreFlightState(cp);
  const s = g2.flight.shipState;
  check(4, '飞行中保存后可在太空检查点继续', ok && valid.ok && !badPos.ok && !badKind.ok && restored &&
    g2.mode === 'space' && Math.abs(s.pos.x - 123) < 1e-9 && Math.abs(s.throttle - 0.62) < 1e-9 && g2.flight.phase === 'space',
    { ok, valid: valid.ok, badPos: badPos.reason, badKind: badKind.reason, restored, mode: g2.mode, pos: s.pos.toArray() });
}
// 过渡阶段记录为落地检查点
{
  const game = new Game(null);
  game.flight = { phase: 'reentry', targetPlanet: 'emer', shipState: {} };
  game.mode = 'landing';
  game.currentPlanetId = 'emer';
  const cp = game.captureFlightState();
  check(4, '过渡阶段的飞行保存为落地检查点', cp.kind === 'landingCheckpoint' && cp.planet === 'emer', { cp });
}

console.log(JSON.stringify({ total: results.length, pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length, results }, null, 1));
