// 第二批验证：存档、输入、UI、音频、性能（#01–#13、#40、#41、#43–#51）
import * as THREE from 'three';

// ---- DOM / window 桩 ----
const makeEl = () => {
  const el = {
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); } },
    style: {}, dataset: {}, textContent: '', innerHTML: '', children: [], value: '0',
    appendChild(c) { this.children.push(c); return c; }, removeChild() {}, remove() {},
    querySelector: () => makeEl(), querySelectorAll: () => [], addEventListener() {},
    getContext: () => ({ createImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {}, clearRect() {}, save() {}, restore() {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 120 }),
    firstChild: null, parentElement: null, scrollIntoView() {}, getBoundingClientRect2: null,
  };
  return el;
};
const els = {};
globalThis.document = {
  body: makeEl(), documentElement: makeEl(), hidden: false,
  getElementById: (id) => (els[id] ||= makeEl()),
  querySelector: () => makeEl(), querySelectorAll: () => [],
  createElement: () => makeEl(), addEventListener() {}, pointerLockElement: null,
};
const listeners = {};
globalThis.window = {
  addEventListener(t, f) { (listeners[t] ||= []).push(f); },
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false }), AudioContext: function () {},
};
Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true });
globalThis.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, clear() { this._d = {}; },
};

const { Game } = await import('../src/main.js');
const { Input } = await import('../src/core/input.js');
const { BuildingSystem } = await import('../src/base/building.js');

const results = [];
const check = (id, name, pass, detail) => results.push({ id, name, pass: !!pass, detail });

function stubUI() {
  const toasts = [];
  return {
    toasts,
    toast(t, k) { toasts.push({ t, k }); },
    showPrompt() {}, setBuildingMode() {}, dialogue() {}, fadeTo() {},
    setObjective() {}, updateObjectiveProgress() {}, frame() {}, setPlanetTheme() {}, setCockpit() {},
    setSpaceHud() {}, crosshairSpace() {}, planetMarker() {}, mmTerrain: null, mmHeights: null, mmBase: null,
  };
}
function stubAudio() {
  return {
    _engine: 0, _amb: 0, _music: 0, _sfx: 0,
    init: async () => {}, play() {}, setPlanet() {}, updateMusic() {}, updateAmbient() {}, setListener() {},
    setEngine(v) { this._engine = v; },
    setMusicVolume(v) { this._music = v; },
    setSfxVolume(v) { this._sfx = v; },
  };
}
function makeGame() {
  const g = new Game(null);
  g.ui = stubUI();
  g.audio = stubAudio();
  g.player = {
    pos: new THREE.Vector3(0, 0, 0), yaw: 0, camYaw: 1.2, camPitch: 0.35,
    inRocket: false, object: { position: new THREE.Vector3(), visible: true },
    teleport(x, z, yaw) { this.pos.set(x, 0, z); this.yaw = yaw; },
    snapCamera() { this.camSnapped = true; }, _solidCircle() { return false; },
    camTarget: new THREE.Vector3(), camCur: 5.4, camDist: 5.4,
  };
  g.camera = new THREE.PerspectiveCamera();
  g.input = { enabled: true, reset() { this.resetCount = (this.resetCount || 0) + 1; }, requestLock() {}, releaseLock() {}, justPressed: new Set(), touch: { move: { x: 0, y: 0 } } };
  g.planetBases = {};
  g.planetStates = {};
  g.weapon = { energy: 100, maxEnergy: 100, mode: 0, clearEffects() { this.cleared = true; }, damage: 18 };
  g.building = { items: [], serialize() { return [{ type: 'solar', x: 1, z: 1, rot: 0 }]; },
    respawnHabitat() { return null; }, totalCapacity() { return 0; }, landingPadNear() { return null; },
    isOperational() { return true; }, clear() { this.cleared = true; }, cancelPlacing() {}, blockedAt() { return null; }, restore() {}, applyProduction() {} };
  g.resources = { nodes: [], serialize() { return { 'ferrite-0': 42 }; }, restore() {}, group: new THREE.Group(), dispose() {}, update() {}, nearest() { return null; } };
  g.ecosystem = { list: [], group: new THREE.Group(), serialize() { return { 'thornling-0': { dead: 1 } }; }, restore() {}, clear() {} };
  g.building.group = new THREE.Group();
  g.dustPlume = new THREE.Object3D();
  g.rocket = { group: new THREE.Group(), throttle: 0, legs: [], update() {}, openDoor() {} };
  g.rocket.group.userData = {};
  g.terrain = { height: () => 0, slopeAt: () => 0, waterLevel: -3, group: new THREE.Group(), update() {} };
  g.vegetation = { group: new THREE.Group(), blocked() { return null; } };
  g.skyMesh = new THREE.Mesh();
  g.flight = { phase: 'ground', setPhase() {} };
  g.spaceSystem = { setVisible() {} };
  g.palette = { accent: '#8f8', name: '蒙昧之绿' };
  g.paletteMap = { verdant: { name: 'v' }, emer: { name: 'e' }, lumina: { name: 'l' } };
  g.setObjective = () => {};
  g.inventory = { ferrite: 10, silica: 10, bio: 5, lumen: 0, sample: 0 };
  g.spawnPoints = () => ({ player: { x: 8, z: 14, yaw: 0 }, rocket: { x: 0, z: 0, yaw: 0 } });
  g.mode = 'surface';
  g.currentPlanetId = 'verdant';
  g.flight = { phase: 'ground', setPhase() {}, landingYaw: 0, launchYaw: 0, targetPlanet: null, shipState: { pos: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, throttle: 0, speed: 0, warp: 0 }, ship: { group: new THREE.Group(), update() {} }, followCamera() {} };
  return g;
}

// ============ 01 save 返回失败，界面不再谎报成功 ============
{
  const g = makeGame();
  const good = g.save();
  const orig = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  const bad = g.save();
  globalThis.localStorage.setItem = orig;
  check(1, '保存失败返回 ok:false（不再静默成功）', good.ok === true && bad.ok === false && !!bad.data,
    { good: good.ok, bad: bad.ok, hasData: !!bad.data });
}

// ============ 02 星球状态保存/恢复 ============
{
  const g = makeGame();
  g.currentPlanetId = 'verdant';
  g.save();
  const raw = JSON.parse(globalThis.localStorage.getItem('little-cosmos-save-v1'));
  const st = raw.planetStates.verdant;
  check(2, '存档包含采集/生物/基地动态状态', !!st && st.resources['ferrite-0'] === 42 && st.creatures['thornling-0'].dead === 1,
    { hasState: !!st, resources: st && st.resources, creatures: st && st.creatures });
}
// 资源布局可复现
{
  const { ResourceField } = await import('../src/world/resources.js');
  const terrain = { height: () => 0, slopeAt: () => 0, def: { biome: 'verdant', seed: 11 } };
  const a = new ResourceField(terrain, { accent: '#fff' }, Math.random, { planetId: 'verdant', seed: 11 });
  const b = new ResourceField(terrain, { accent: '#fff' }, Math.random, { planetId: 'verdant', seed: 11 });
  const same = a.nodes.length === b.nodes.length && a.nodes.every((n, i) => Math.abs(n.pos.x - b.nodes[i].pos.x) < 1e-9 && n.id === b.nodes[i].id);
  check(2, '同一星球种子生成相同资源布局与稳定 ID', same, { count: a.nodes.length, firstId: a.nodes[0] && a.nodes[0].id });
}

// ============ 03 非法存档被拒绝且回到菜单 ============
{
  const g = makeGame();
  const bad = { version: 3, planet: 'bogus', inventory: {}, bases: {} };
  const r = g.validateSave(bad);
  const badType = g.validateSave({ version: 3, planet: 'verdant', bases: { emer: [{ type: 'ufo', x: 0, z: 0 }] } });
  const ok = g.validateSave({ version: 3, planet: 'emer', inventory: { ferrite: 1 }, bases: { emer: [{ type: 'solar', x: 1, z: 2 }] } });
  const nanInv = g.validateSave({ version: 3, planet: 'verdant', inventory: { ferrite: NaN } });
  check(3, '非法星球/建筑/数值的存档被拒绝', !r.ok && !badType.ok && !nanInv.ok && ok.ok,
    { bogusPlanet: r.reason, badType: badType.reason, nan: nanInv.reason, validOk: ok.ok });
}

// ============ 05 保存/恢复镜头朝向 ============
{
  const g = makeGame();
  const cap = g.capturePlayerState();
  const hasCam = Number.isFinite(cap.camYaw) && Number.isFinite(cap.camPitch);
  g.applyPlayerState({ x: 5, z: 6, yaw: 0.2, camYaw: 2.4, camPitch: -0.5 });
  check(5, '存档记录并恢复 camYaw/camPitch', hasCam && Math.abs(g.player.camYaw - 2.4) < 1e-9 && Math.abs(g.player.camPitch - -0.5) < 1e-9 && !!g.savedCamera,
    { hasCam, camYaw: g.player.camYaw, camPitch: g.player.camPitch });
}

// ============ 40 落点避开基地建筑；51 优先停机坪 ============
{
  const g = makeGame();
  g.vegetation = { blocked() { return null; } };
  g.terrain = { height: () => 2, slopeAt: () => 0.05, waterLevel: -3 };
  const habit = { type: 'habitat', def: BUILDINGS_HAB(), pos: new THREE.Vector3(8, 2, 14), built: 1 };
  g.building.items = [habit];
  const spot = g.findLandingSpot('verdant');
  const distToHabit = Math.hypot(spot.x - habit.pos.x, spot.z - habit.pos.z);
  // 停机坪优先
  g.building.landingPadNear = () => ({ type: 'pad', def: { size: [5, 0.5, 5], colliderR: 0 }, pos: new THREE.Vector3(40, 2, 40), built: 1 });
  const padSpot = g.findLandingSpot('verdant');
  check(40, '自动着陆避开已有建筑', distToHabit > 4.0, { spot: [spot.x, spot.z], distToHabit });
  check(51, '存在合法停机坪时优先降落其上', padSpot.pad === true && padSpot.x === 40, { pad: padSpot.pad, x: padSpot.x });
}
function BUILDINGS_HAB() { return { colliderR: 1.45, size: [3.2, 2.4, 3.2] }; }

// ============ 41 返回菜单复位火箭 ============
{
  const g = makeGame();
  g.currentPlanetId = 'verdant';
  g.rocket.group.position.set(-1729, -259, -864);
  g.showMenu();
  const d = Math.hypot(g.rocket.group.position.x - 0, g.rocket.group.position.z - 0);
  check(41, '返回菜单时火箭回到地表落点', d < 5 && Math.abs(g.rocket.group.position.y - 0) < 1e-6,
    { pos: g.rocket.group.position.toArray() });
}

// ============ 45 离开太空后引擎归零 ============
{
  const g = makeGame();
  const { FlightSystem } = await import('../src/ship/flight.js');
  const f = new FlightSystem(g);
  g.audio.setEngine(0.9, 0.5);
  f.setPhase('space');
  const inSpace = g.audio._engine;
  f.setPhase('ground');
  check(45, '离开太空后引擎目标音量为 0', inSpace > 0 && g.audio._engine === 0, { inSpace, ground: g.audio._engine });
}

// ============ 46 音效滑块控制环境声与引擎 ============
{
  const { AudioEngine } = await import('../src/core/audio.js');
  const a = new AudioEngine();
  const gained = { gain: { value: 0.8 }, connect() {} };
  a.ctx = { createGain: () => ({ gain: { value: 0 }, connect() {} }) };
  a.sfxBus = { gain: { value: 1 }, connect() {} };
  a.ambBus = { gain: { value: 0.8 }, connect() {} };
  a.ambGainBase = 0.8;
  a.setSfxVolume(0);
  check(46, '音效=0 时环境声总线也为 0', Math.abs(a.ambBus.gain.value) < 1e-9 && a.sfxVol === 0, { amb: a.ambBus.gain.value, sfx: a.sfxVol });
}

// ============ 47 音乐调度不再追赶旧时间 ============
{
  const { AudioEngine } = await import('../src/core/audio.js');
  const a = new AudioEngine();
  a.ctx = { currentTime: 100, createOscillator: () => ({ frequency: {}, connect: () => ({ connect: () => ({ connect() {} }) }), start() {}, stop() {} }),
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect: () => ({ connect: () => {}, }) }),
    createDelay: () => ({ delayTime: {}, connect() {} }) };
  a.started = true; a.bpm = 64; a.scales = [[0, 3, 7, 10, 12, 15, 19]]; a.chordIdx = 0; a.musicStep = 0;
  a.musicBus = { connect() {} };
  a.nextNoteTime = 10; // 落后 90 秒
  let scheduled = false;
  a._pad = () => { scheduled = true; };
  a.updateMusic(1 / 60, 0.2);
  check(47, '恢复后 nextNoteTime 对齐当前时间（不补排旧音符）', a.nextNoteTime > 100 && a.nextNoteTime < 101.5,
    { nextNoteTime: a.nextNoteTime, now: 100, scheduled });
}

// ============ 50 存储容量 ============
{
  const g = makeGame();
  const b = new BuildingSystem({ ...g, scene: new THREE.Scene() });
  b.restore([{ type: 'storage', x: 0, z: 0 }, { type: 'storage', x: 5, z: 0 }]);
  b.gen = 2; b.baseUse = 0; b.update(1 / 60, null);
  const cap = b.totalCapacity();
  check(50, '资源存储提供实际容量', cap === 120, { cap });
}

// ============ 49 居住舱重生点 ============
{
  const g = makeGame();
  const b = new BuildingSystem({ ...g, scene: new THREE.Scene() });
  b.restore([{ type: 'habitat', x: 12, z: 4 }]);
  b.gen = 2; b.baseUse = 0; b.update(1 / 60, null);
  const hab = b.respawnHabitat(new THREE.Vector3(0, 0, 0));
  check(49, '已建成居住舱可作为重生点', !!hab && hab.type === 'habitat', { found: !!hab, pos: hab && [hab.pos.x, hab.pos.z] });
}

console.log(JSON.stringify({ total: results.length, pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length, results }, null, 1));
